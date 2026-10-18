// Warm-up for the shared admin MediaLive channel.
//
// AWS takes anywhere from ~1 to 5+ minutes to bring a MediaLive channel from
// IDLE to RUNNING, and StreamYard's RTMP push is rejected until then — so
// clicking "Go Live" at showtime loses the opening minutes. Warming up means
// starting the AWS channel ahead of time WITHOUT announcing the stream.
//
// Runs from the every-minute live-billing-tick hook:
//   * auto-warm: a scheduled admin stream whose scheduled_for is within the
//     next WARM_LEAD_MS gets the channel started once.
//   * auto-cool: if the channel was warmed but nobody went live within
//     COOL_AFTER_MS, stop it so AWS doesn't bill an empty channel all day.

export const WARM_LEAD_MS = 15 * 60_000;
export const COOL_AFTER_MS = 45 * 60_000;

export async function warmSharedChannel(streamId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { startChannel, describeChannel } = await import("./aws-medialive.server");
  const current = await describeChannel().catch(() => null);
  if (!current || (current.state !== "RUNNING" && current.state !== "STARTING")) {
    await startChannel();
  }
  await (supabaseAdmin as any)
    .from("live_streams")
    .update({ warmup_started_at: new Date().toISOString() })
    .eq("id", streamId);
  return { state: current?.state === "RUNNING" ? "RUNNING" : "STARTING" };
}

export async function runWarmupTick(): Promise<Record<string, unknown>> {
  const shared = process.env.MEDIALIVE_CHANNEL_ID;
  if (!shared) return { skipped: "no shared channel" };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { describeChannel, stopChannel } = await import("./aws-medialive.server");
  const now = Date.now();
  const out: Record<string, unknown> = {};

  // Admin (shared-channel) streams only — per-user channels bill themselves.
  const { data: scheduled } = await (supabaseAdmin as any)
    .from("live_streams")
    .select("id, scheduled_for, warmup_started_at")
    .eq("status", "scheduled")
    .is("channel_row_id", null)
    .not("scheduled_for", "is", null)
    .gte("scheduled_for", new Date(now - 30 * 60_000).toISOString())
    .lte("scheduled_for", new Date(now + WARM_LEAD_MS).toISOString());

  for (const s of scheduled ?? []) {
    if (s.warmup_started_at) continue;
    try {
      await warmSharedChannel(s.id);
      out[`warmed_${s.id}`] = true;
    } catch (err) {
      out[`warm_error_${s.id}`] = err instanceof Error ? err.message : String(err);
    }
  }

  // Auto-cool: warmed long ago, still not live, nothing else using the channel.
  const { data: warmed } = await (supabaseAdmin as any)
    .from("live_streams")
    .select("id, warmup_started_at")
    .eq("status", "scheduled")
    .is("channel_row_id", null)
    .not("warmup_started_at", "is", null)
    .lte("warmup_started_at", new Date(now - COOL_AFTER_MS).toISOString())
    .gte("warmup_started_at", new Date(now - 6 * 3600_000).toISOString());
  if ((warmed ?? []).length > 0) {
    const { count } = await (supabaseAdmin as any)
      .from("live_streams")
      .select("id", { count: "exact", head: true })
      .is("channel_row_id", null)
      .in("status", ["starting", "live"]);
    if (!count) {
      const st = await describeChannel().catch(() => null);
      if (st && (st.state === "RUNNING" || st.state === "STARTING")) {
        await stopChannel().catch(() => null);
        out.cooled = true;
      }
    }
  }
  return out;
}
