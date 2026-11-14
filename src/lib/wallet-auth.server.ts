// Stateless wallet-session auth.
//
// Two HMAC-SHA256 signed tokens:
//   1. Challenge token — short-lived (5 min), wraps {wallet, nonce, message}.
//      Issued by `requestWalletLogin`, returned to client, must be echoed
//      back to `completeWalletLogin` along with the user's signature. This
//      lets us verify the signed message without persisting nonces in the DB.
//   2. Session token — 7 days, wraps {wallet, sid}. Sent as
//      `Authorization: Bearer <token>` on every protected server fn. Each
//      session also has a wallet_sessions row so it can be revoked early.
//
// We intentionally do NOT use a separate JWT library. The Worker runtime
// has `crypto.subtle` natively, so a tiny HS256 implementation is enough
// and avoids adding a Node-only dep that breaks at the edge.

const CHALLENGE_TTL_SEC = 5 * 60;
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

function getSecret(): string {
  // Dedicated signing secret (never the database service key). Rotating it
  // signs everyone out.
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("Server is missing SESSION_SECRET");
  return s;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const body = b64urlEncode(new TextEncoder().encode(json));
  const key = await hmacKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verify<T>(token: string): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const key = await hmacKey();
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let parsed: { exp?: number } & Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (typeof parsed.exp === "number" && parsed.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return parsed as T;
}

export interface ChallengeClaims {
  kind: "wallet-challenge";
  wallet: string;
  nonce: string;
  message: string;
  iat: number;
  exp: number;
}

export interface SessionClaims {
  kind: "wallet-session";
  wallet: string;
  sid: string;
  iat: number;
  exp: number;
}

export async function issueChallengeToken(args: {
  wallet: string;
  nonce: string;
  message: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    kind: "wallet-challenge",
    wallet: args.wallet,
    nonce: args.nonce,
    message: args.message,
    iat: now,
    exp: now + CHALLENGE_TTL_SEC,
  } satisfies ChallengeClaims);
}

export async function verifyChallengeToken(
  token: string,
): Promise<ChallengeClaims | null> {
  const claims = await verify<ChallengeClaims>(token);
  if (!claims || claims.kind !== "wallet-challenge") return null;
  return claims;
}

async function sessionsDb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export async function issueSessionToken(wallet: string, userAgent?: string | null): Promise<{
  token: string;
  expiresAt: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_SEC;
  const db = await sessionsDb();
  const { data: row, error } = await db
    .from("wallet_sessions")
    .insert({
      wallet,
      expires_at: new Date(exp * 1000).toISOString(),
      user_agent: userAgent ? userAgent.slice(0, 300) : null,
    })
    .select("id")
    .single();
  if (error || !row) throw new Error("Could not start your session — try again.");
  const token = await sign({
    kind: "wallet-session",
    wallet,
    sid: row.id,
    iat: now,
    exp,
  } satisfies SessionClaims);
  return { token, expiresAt: exp };
}

/** Signature check only (no database). Exported for tests. */
export async function readSessionClaims(token: string): Promise<SessionClaims | null> {
  const claims = await verify<SessionClaims>(token);
  if (!claims || claims.kind !== "wallet-session" || typeof claims.sid !== "string") return null;
  return claims;
}

/** Valid signature AND a live (not revoked, not expired) server-side session. */
export async function verifySessionToken(
  token: string,
): Promise<SessionClaims | null> {
  const claims = await readSessionClaims(token);
  if (!claims) return null;
  const db = await sessionsDb();
  const { data: row } = await db
    .from("wallet_sessions")
    .select("wallet, expires_at, revoked_at, last_seen_at")
    .eq("id", claims.sid)
    .maybeSingle();
  if (!row || row.revoked_at || row.wallet !== claims.wallet) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60_000) {
    void db.from("wallet_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", claims.sid).then(() => null, () => null);
  }
  return claims;
}

/** Cancel one session (sign out on this device). */
export async function revokeSession(sid: string, wallet: string): Promise<void> {
  const db = await sessionsDb();
  await db
    .from("wallet_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sid)
    .eq("wallet", wallet)
    .is("revoked_at", null);
}

/** Cancel every session for a wallet (sign out everywhere). Returns how many. */
export async function revokeAllSessions(wallet: string): Promise<number> {
  const db = await sessionsDb();
  const { data } = await db
    .from("wallet_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("wallet", wallet)
    .is("revoked_at", null)
    .select("id");
  return data?.length ?? 0;
}
// ---- honest.money SSO: short-lived "link this member to a wallet" token ----
export interface HmLinkClaims {
  kind: "hm-link";
  memberId: string;
  email: string | null;
  iat: number;
  exp: number;
}

export async function issueHmLinkToken(memberId: string, email: string | null): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ kind: "hm-link", memberId, email, iat: now, exp: now + 15 * 60 } satisfies HmLinkClaims);
}

export async function verifyHmLinkToken(token: string): Promise<HmLinkClaims | null> {
  const c = await verify<HmLinkClaims>(token);
  if (!c || c.kind !== "hm-link") return null;
  return c;
}

// Only the requesting browser receives this proof; never include it in a QR.
export async function issueWalletBrowserProof(challengeId: string, expiresAt: string): Promise<string> {
  return sign({ kind: "wallet-browser", challengeId, exp: Math.floor(new Date(expiresAt).getTime() / 1000) });
}

export async function verifyWalletBrowserProof(token: string | null, challengeId: string): Promise<boolean> {
  if (!token) return false;
  const claims = await verify<{ kind: string; challengeId: string; exp: number }>(token);
  return claims?.kind === "wallet-browser" && claims.challengeId === challengeId &&
    typeof claims.exp === "number" && claims.exp > Math.floor(Date.now() / 1000);
}
