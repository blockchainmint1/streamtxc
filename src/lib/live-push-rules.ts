// Pushed "go live" alerts to partner sites. streamTXC tells a site when a
// stream starts/ends only if the creator switched that site on, so tests and
// unchosen streams never appear there. Each creator enters the site's address
// and a shared key; messages are HMAC-signed with that key.
export const MAX_LIVE_PUSH_SITES = 5;

/** Partner listener address: public https host only (no IPs, localhost or internal names). */
export function validatePushEndpoint(raw: string): string {
  const url = raw.trim();
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("Enter the full web address, like https://example.com/api/public/streamtxc-live."); }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("The address must start with https:// (no port or login).");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^[0-9.]+$/.test(h) || h.includes(":")) throw new Error("Use a normal website name, not a number address.");
  if (h === "localhost" || /\.(local|internal|localhost|lan|home|arpa)$/.test(h)) throw new Error("That address isn't on the public internet.");
  if (url.length > 300) throw new Error("That address is too long.");
  return u.toString();
}

export function validatePushKey(raw: string): string {
  const k = raw.trim();
  if (k.length < 16 || k.length > 400 || /\s/.test(k)) throw new Error("The key must be at least 16 characters with no spaces.");
  return k;
}

/** While live, re-send every 5 minutes so receivers can expire a missed "ended". */
export const LIVE_HEARTBEAT_MS = 5 * 60_000;

export type PushTarget = { enabled: boolean; lastState: string; lastStreamId: string | null; lastPushedAt: number | null; lastError: string | null };
export type PushAction = "live" | "ended" | null;

export function decidePush(t: PushTarget, liveStreamId: string | null, now: number): PushAction {
  const want = t.enabled && liveStreamId ? "live" : "off";
  if (want === "live") {
    if (t.lastState !== "live" || t.lastStreamId !== liveStreamId || t.lastError) return "live";
    return t.lastPushedAt == null || now - t.lastPushedAt >= LIVE_HEARTBEAT_MS ? "live" : null;
  }
  return t.lastState === "live" ? "ended" : null;
}

export async function signBody(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
