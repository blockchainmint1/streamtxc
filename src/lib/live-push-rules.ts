// Pushed "go live" alerts to partner sites. streamTXC tells a site when a
// stream starts/ends only if the creator switched that site on, so tests and
// unchosen streams never appear there. Messages are HMAC-signed per site.
export const LIVE_PUSH_SITES = {
  "honest-money": {
    label: "honest.money/live",
    endpoint: "https://honest.money/api/public/streamtxc-live",
    secretEnv: "LIVE_PUSH_SECRET_HONEST_MONEY",
  },
  texitcoin: {
    label: "texitcoin.org/zoom",
    endpoint: "https://texitcoin.org/api/public/streamtxc-live",
    secretEnv: "LIVE_PUSH_SECRET_TEXITCOIN",
  },
} as const;
export type LivePushSite = keyof typeof LIVE_PUSH_SITES;
export const isLivePushSite = (s: string): s is LivePushSite => Object.hasOwn(LIVE_PUSH_SITES, s);

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
