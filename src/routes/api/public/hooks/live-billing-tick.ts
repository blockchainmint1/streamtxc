// Phase C billing tick: runs every minute.
//
// For each RUNNING per-user live_channels row:
//   1. Sync deposits (credits new incoming TXC to the wallet's ledger).
//   2. Insert a `consumption` row of -rate.
//   3. If the resulting balance is below one minute of rate OR the active
//      stream has exceeded `live_max_concurrent_minutes`, call stopChannel
//      and mark the stream ended.
//
// Guarded by x-admin-token = TXC_RPC_PASS.

import { createFileRoute } from "@tanstack/react-router";
import { secretMatches } from "@/lib/admin-token";

export const Route = createFileRoute("/api/public/hooks/live-billing-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!secretMatches(provided, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { syncDepositsForWallet, computeBalance, getWalletRatePerMin } = await import(
          "@/lib/live-credits.functions"
        );
        const { stopChannel, describeChannel } = await import("@/lib/aws-medialive.server");

        // Pick channels that are (or think they are) running.
        const { data: channels, error } = await (supabaseAdmin as any)
          .from("live_channels")
          .select("id, owner_wallet, medialive_channel_id, status")
          .in("status", ["starting", "running"]);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const results: Array<Record<string, unknown>> = [];
        for (const ch of channels ?? []) {
          try {
            // Sync deposits first so a top-up in this minute keeps the
            // channel alive.
            await syncDepositsForWallet(ch.owner_wallet).catch(() => null);

            const state = await describeChannel(ch.medialive_channel_id).catch(
              () => ({ state: "UNKNOWN" as const }),
            );
            // Only bill when AWS confirms RUNNING. STARTING is free; STOPPED
            // means our DB flag is stale — reconcile it.
            if (state.state !== "RUNNING") {
              if (state.state === "IDLE" || state.state === "STOPPED") {
                await (supabaseAdmin as any)
                  .from("live_channels")
                  .update({ status: "idle" })
                  .eq("id", ch.id);
                results.push({ channel: ch.medialive_channel_id, action: "reconciled_idle" });
              } else {
                results.push({ channel: ch.medialive_channel_id, action: "not_running", state: state.state });
              }
              continue;
            }

            const rate = await getWalletRatePerMin(ch.owner_wallet);
            const { data: activeStream } = await (supabaseAdmin as any)
              .from("live_streams")
              .select("id, started_at")
              .eq("channel_row_id", ch.id)
              .in("status", ["starting", "live"])
              .order("started_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            await (supabaseAdmin as any).from("live_credit_ledger").insert({
              wallet: ch.owner_wallet,
              delta_txc: -rate,
              kind: "consumption",
              stream_id: activeStream?.id ?? null,
              note: "1m tick",
            });
            const newBalance = await computeBalance(ch.owner_wallet);

            // Concurrency-minute cap.
            let stopReason: string | null = null;
            if (newBalance < rate) stopReason = "out_of_credits";
            if (activeStream?.started_at) {
              const minutes =
                (Date.now() - new Date(activeStream.started_at).getTime()) / 60_000;
              const { data: prefs } = await (supabaseAdmin as any)
                .from("wallet_notification_prefs")
                .select("live_max_concurrent_minutes")
                .eq("wallet", ch.owner_wallet)
                .maybeSingle();
              const cap = Number(prefs?.live_max_concurrent_minutes ?? 240);
              if (minutes >= cap) stopReason = stopReason ?? "max_minutes_reached";
            }

            if (stopReason) {
              await stopChannel(ch.medialive_channel_id).catch(() => null);
              await (supabaseAdmin as any)
                .from("live_channels")
                .update({ status: "stopping" })
                .eq("id", ch.id);
              if (activeStream) {
                await (supabaseAdmin as any)
                  .from("live_streams")
                  .update({
                    status: "ended",
                    ended_at: new Date().toISOString(),
                    stopped_reason: stopReason,
                  })
                  .eq("id", activeStream.id);
              }
              results.push({
                channel: ch.medialive_channel_id,
                action: "stopped",
                reason: stopReason,
                balance: newBalance,
              });
            } else {
              results.push({
                channel: ch.medialive_channel_id,
                action: "billed",
                rate,
                balance: newBalance,
              });
            }
          } catch (err) {
            results.push({
              channel: ch.medialive_channel_id,
              action: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Pre-show warm-up / auto-cool for the shared admin channel.
        let warmup: Record<string, unknown> = {};
        try {
          const { runWarmupTick } = await import("@/lib/live-warmup.server");
          warmup = await runWarmupTick();
        } catch (err) {
          warmup = { error: err instanceof Error ? err.message : String(err) };
        }
        // Team meetings (/meet): charge open paid rooms per minute.
        let meetings: Record<string, unknown> = {};
        try {
          const { runMeetingBillingTick } = await import("@/lib/meeting-billing.server");
          meetings = await runMeetingBillingTick();
        } catch (err) {
          meetings = { error: err instanceof Error ? err.message : String(err) };
        }
        // Meeting recordings: finish files + AI notes, move publishes along (no-op when idle).
        let recordings: unknown = null;
        try {
          const { runMeetingRecordingTick } = await import("@/lib/meeting-recording.server");
          recordings = await runMeetingRecordingTick(new URL(request.url).origin);
        } catch (err) {
          recordings = { error: err instanceof Error ? err.message : String(err) };
        }
        return Response.json({ ok: true, considered: channels?.length ?? 0, results, warmup, meetings, recordings });
      },
    },
  },
});