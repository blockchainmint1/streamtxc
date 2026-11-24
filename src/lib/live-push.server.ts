import { decidePush, signBody } from "./live-push-rules";
import { openPushKey } from "./push-crypto.server";

const ORIGIN = "https://streamtxc.com";

/** Runs from the every-minute live tick: sends live/ended alerts to each creator's chosen sites. */
export async function runLivePushTick() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const { data: targets } = await db.from("live_push_sites").select("*");
  const out: Array<Record<string, unknown>> = [];
  const liveCache = new Map<string, any>();
  const owners = [...new Set((targets ?? []).map((t: any) => t.owner_wallet as string))];
  await Promise.all(owners.map(async (w) => {
    const { data } = await db.from("live_streams")
      .select("id, title, started_at").eq("owner_wallet", w).eq("status", "live")
      .order("started_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    liveCache.set(w as string, data ?? null);
  }));
  // All sites at once, so a few slow or dead sites can't stretch the tick.
  await Promise.all((targets ?? []).map(async (t: any) => {
    if (!liveCache.has(t.owner_wallet)) {
      const { data } = await db.from("live_streams")
        .select("id, title, started_at").eq("owner_wallet", t.owner_wallet).eq("status", "live")
        .order("started_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
      liveCache.set(t.owner_wallet, data ?? null);
    }
    const s = liveCache.get(t.owner_wallet);
    const now = Date.now();
    const action = decidePush({
      enabled: t.enabled, lastState: t.last_state, lastStreamId: t.last_stream_id,
      lastPushedAt: t.last_pushed_at ? Date.parse(t.last_pushed_at) : null, lastError: t.last_error,
    }, s?.id ?? null, now);
    if (!action) return;
    const streamId = action === "live" ? s.id : t.last_stream_id;
    let err: string | null = null;
    try {
      const secret = await openPushKey(t.secret_sealed);
      const body = JSON.stringify({
        event: action, siteId: t.id, wallet: t.owner_wallet, streamId,
        title: action === "live" ? s.title : null,
        startedAt: action === "live" ? s.started_at : null,
        embedUrl: streamId ? `${ORIGIN}/embed/live/${streamId}` : null,
        watchUrl: streamId ? `${ORIGIN}/live/${streamId}` : null,
        sentAt: new Date(now).toISOString(), nonce: crypto.randomUUID(),
      });
      const ts = Math.floor(now / 1000);
      const res = await fetch(t.endpoint, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", "x-streamtxc-signature": `t=${ts},v1=${await signBody(secret, ts, body)}` },
        body, signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) err = `site answered ${res.status}`;
    } catch { err = err ?? "site didn't answer"; }
    await db.from("live_push_sites").update({
      last_state: err ? t.last_state : action === "live" ? "live" : "off",
      last_stream_id: streamId, last_pushed_at: new Date(now).toISOString(), last_error: err, updated_at: new Date(now).toISOString(),
    }).eq("id", t.id);
    out.push({ site: t.id, action, ok: !err });
  }));
  return out;
}
