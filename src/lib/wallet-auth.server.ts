// Stateless wallet-session auth.
//
// Two HMAC-SHA256 signed tokens:
//   1. Challenge token — short-lived (5 min), wraps {wallet, nonce, message}.
//      Issued by `requestWalletLogin`, returned to client, must be echoed
//      back to `completeWalletLogin` along with the user's signature. This
//      lets us verify the signed message without persisting nonces in the DB.
//   2. Session token — long-lived (7 days), wraps {wallet}. Sent as
//      `Authorization: Bearer <token>` on every protected server fn.
//
// We intentionally do NOT use a separate JWT library. The Worker runtime
// has `crypto.subtle` natively, so a tiny HS256 implementation is enough
// and avoids adding a Node-only dep that breaks at the edge.

const CHALLENGE_TTL_SEC = 5 * 60;
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

function getSecret(): string {
  // Reuse the service-role key as the HMAC secret. It's already server-only,
  // stable, and rotation invalidates outstanding sessions — which is what we
  // want.
  const s = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("Server is missing SUPABASE_SERVICE_ROLE_KEY");
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

export async function issueSessionToken(wallet: string): Promise<{
  token: string;
  expiresAt: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_SEC;
  const token = await sign({
    kind: "wallet-session",
    wallet,
    iat: now,
    exp,
  } satisfies SessionClaims);
  return { token, expiresAt: exp };
}

export async function verifySessionToken(
  token: string,
): Promise<SessionClaims | null> {
  const claims = await verify<SessionClaims>(token);
  if (!claims || claims.kind !== "wallet-session") return null;
  return claims;
}