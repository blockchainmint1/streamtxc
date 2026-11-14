// Per-minute meeting billing, run from the every-minute live billing tick.
// Each open, paid room is charged (seats × seat price + live-stream add-on) in TXC
// from the host's prepaid balance (the same balance live streaming uses).
// When the host can't cover the next minute, the meeting is closed for everyone.

import { isMeetingBillable, meetingMinuteUsd, recordingMinuteUsd, shouldEndForCredit, usdToTxc8 } from "./meeting-rules";

import { ADMIN_WALLET } from "./admin";

export async function runMeetingBillingTick() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const sb = supabaseAdmin as any;
  const chime = await import("./aws-chime.server");
  const credits = await import("./live-credits.functions");
  const { getTxcUsdPrice } = await import("./txc-price.server");
  const recording = await import("./meeting-recording.server");

  const { data: rooms, error } = await sb
    .from("meeting_rooms")
    .select("id, owner_wallet, chime_meeting_id, broadcast_pipeline_id")
    .not("chime_meeting_id", "is", null);
  if (error) return { error: error.message };

  const results: Array<Record<string, unknown>> = [];
  const txcUsd = (await getTxcUsdPrice()).usd;

  for (const room of rooms ?? []) {
    try {
      const live = await chime.getMeeting(room.chime_meeting_id);
      if (!live) {
        await recording.stopRoomRecordings(room.id).catch(() => {});
        await sb.from("meeting_rooms")
          .update({ chime_meeting_id: null, chime_meeting: null, broadcast_pipeline_id: null, broadcast_started_at: null })
          .eq("id", room.id);
        results.push({ room: room.id, action: "closed_by_aws" });
        continue;
      }
      if (!isMeetingBillable(room.owner_wallet, ADMIN_WALLET)) {
        results.push({ room: room.id, action: "free_admin_room" });
        continue;
      }

      // Never charge the same room twice in one minute (e.g. a doubled cron run).
      const note = `meeting ${room.id}`;
      const { data: recent } = await sb
        .from("live_credit_ledger")
        .select("id")
        .eq("wallet", room.owner_wallet)
        .eq("kind", "meeting")
        .eq("note", note)
        .gt("created_at", new Date(Date.now() - 50_000).toISOString())
        .limit(1);
      if (recent?.length) {
        results.push({ room: room.id, action: "already_billed" });
        continue;
      }

      const seats = await chime.countAttendees(room.chime_meeting_id);
      const broadcasting = !!room.broadcast_pipeline_id;
      const rec = await recording.activeRecording(room.id);
      const recUsd = rec ? recordingMinuteUsd(rec.record_video, rec.take_notes) : 0;
      const minuteTxc = usdToTxc8(meetingMinuteUsd(seats, broadcasting) + recUsd, txcUsd);
      await credits.syncDepositsForWallet(room.owner_wallet).catch(() => null);
      if (minuteTxc > 0) {
        await sb.from("live_credit_ledger").insert({
          wallet: room.owner_wallet,
          delta_txc: -minuteTxc,
          kind: "meeting",
          note,
        });
      }
      const balance = await credits.computeBalance(room.owner_wallet);
      if (shouldEndForCredit(balance, minuteTxc)) {
        if (room.broadcast_pipeline_id) await chime.stopMediaPipeline(room.broadcast_pipeline_id).catch(() => {});
        await recording.stopRoomRecordings(room.id).catch(() => {});
        await chime.deleteMeeting(room.chime_meeting_id).catch(() => {});
        await sb.from("meeting_rooms")
          .update({ chime_meeting_id: null, chime_meeting: null, broadcast_pipeline_id: null, broadcast_started_at: null })
          .eq("id", room.id);
        results.push({ room: room.id, action: "ended_out_of_credit", seats, balance });
      } else {
        results.push({ room: room.id, action: "billed", seats, broadcasting, recording: !!rec, minuteTxc, balance });
      }
    } catch (err) {
      results.push({ room: room.id, action: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { considered: rooms?.length ?? 0, results };
}
