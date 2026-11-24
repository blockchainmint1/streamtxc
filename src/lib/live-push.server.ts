import { ADMIN_WALLET } from "./admin";
import { LIVE_PUSH_SITES, decidePush, isLivePushSite, signBody, type LivePushSite } from "./live-push-rules";

const ORIGIN = "https://streamtxc.com";

/** Runs from the every-minute live tick: sends live/ended alerts to chosen sites. */
export async function runLivePushTick() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const { data: targets } = await db.from("live_push_targets").select("*");
  const out: Array<Record<string, unknown>> = [];
  for (const t of targets ?? []) {
    if (!isLivePushSite(t.site) || t.owner_wallet !== ADMIN_WALLET) continue;
    const { data: s } = await db.from("live_streams")
      .select("id, title, started_at").eq("owner_wallet", t.owner_wallet).eq("status", "live")
      .order("started_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    const now = Date.now();
    const action = decidePush({
      enabled: t.enabled, lastState: t.last_state, lastStreamId: t.last_stream_id,
      lastPushedAt: t.last_pushed_at ? Date.parse(t.last_pushed_at) : null, lastError: t.last_error,
    }, s?.id ?? null, now);
    if (!action) continue;
    const site = LIVE_PUSH_SITES[t.site as LivePushSite];
    const secret = process.env[site.secretEnv];
    const streamId = action === "live" ? s.id : t.last_stream_id;
    let err: string | null = null;
    if (!secret) err = "not set up yet";
    else {
      const body = JSON.stringify({
        event: action, site: t.site, streamId,
        title: action === "live" ? s.title : null,
        startedAt: action === "live" ? s.started_at : null,
        embedUrl: streamId ? `${ORIGIN}/embed/live/${streamId}` : null,
        watchUrl: streamId ? `${ORIGIN}/live/${streamId}` : null,
        sentAt: new Date(now).toISOString(), nonce: crypto.randomUUID(),
      });
      const ts = Math.floor(now / 1000);
      try {
        const res = await fetch(site.endpoint, {
          method: "POST", redirect: "manual",
          headers: { "content-type": "application/json", "x-streamtxc-signature": `t=${ts},v1=${await signBody(secret, ts, body)}` },
          body, signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) err = `site answered ${res.status}`;
      } catch { err = "site didn't answer"; }
    }
    await db.from("live_push_targets").update({
      last_state: err ? t.last_state : action === "live" ? "live" : "off",
      last_stream_id: streamId, last_pushed_at: new Date(now).toISOString(), last_error: err, updated_at: new Date(now).toISOString(),
    }).eq("owner_wallet", t.owner_wallet).eq("site", t.site);
    out.push({ site: t.site, action, ok: !err });
  }
  return out;
}
