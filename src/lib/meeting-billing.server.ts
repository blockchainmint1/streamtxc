// Per-minute meeting billing, run from the every-minute live billing tick.
// Each open, paid room is charged (connected seats × seat price + live-stream
// add-on + recording) in TXC from the host's prepaid balance (the same balance
// live streaming uses). Only seats whose browser is checking in count; seats
// that never connected or went quiet are removed from the meeting.
// The meeting closes when the host can't cover the next minute, when it would
// eat into the money the host's running live stream needs, or when the host has
// been gone too long from a room the team isn't allowed to run alone.

import {
  isMeetingBillable, meetingMinuteUsd, recordingMinuteUsd, shouldEndForCredit, usdToTxc8,
  seatIsLive, seatIsAbandoned, hostAbsentTooLong, shouldEndForLiveReserve, type SeatState,
} from "./meeting-rules";

import { ADMIN_WALLET } from "./admin";

type Seat = SeatState & { id: string; attendee_id: string; role: string };

export async function runMeetingBillingTick() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const sb = supabaseAdmin as any;
  const chime = await import("./aws-chime.server");
  const credits = await import("./live-credits.functions");
  const { getTxcUsdPrice } = await import("./txc-price.server");
  const recording = await import("./meeting-recording.server");

  const { data: rooms, error } = await sb
    .from("meeting_rooms")
    .select("id, owner_wallet, chime_meeting_id, broadcast_pipeline_id, team_can_start, updated_at")
    .not("chime_meeting_id", "is", null);
  if (error) return { error: error.message };

  const results: Array<Record<string, unknown>> = [];
  const txcUsd = (await getTxcUsdPrice()).usd;

  const closeRoom = async (room: any) => {
    if (room.broadcast_pipeline_id) await chime.stopMediaPipeline(room.broadcast_pipeline_id).catch(() => {});
    await recording.stopRoomRecordings(room.id).catch(() => {});
    await chime.deleteMeeting(room.chime_meeting_id).catch(() => {});
    await sb.from("meeting_rooms")
      .update({ chime_meeting_id: null, chime_meeting: null, broadcast_pipeline_id: null, broadcast_started_at: null })
      .eq("id", room.id);
    await sb.from("meeting_seats").update({ left_at: new Date().toISOString() })
      .eq("meeting_id", room.chime_meeting_id).is("left_at", null);
  };

  for (const room of rooms ?? []) {
    try {
      const live = await chime.getMeeting(room.chime_meeting_id);
      if (!live) {
        await recording.stopRoomRecordings(room.id).catch(() => {});
        await sb.from("meeting_rooms")
          .update({ chime_meeting_id: null, chime_meeting: null, broadcast_pipeline_id: null, broadcast_started_at: null })
          .eq("id", room.id);
        await sb.from("meeting_seats").update({ left_at: new Date().toISOString() })
          .eq("meeting_id", room.chime_meeting_id).is("left_at", null);
        results.push({ room: room.id, action: "closed_by_aws" });
        continue;
      }

      // Clear out seats that never connected or stopped checking in.
      const now = Date.now();
      const { data: seatRows } = await sb
        .from("meeting_seats")
        .select("id, attendee_id, role, created_at, last_seen_at, left_at")
        .eq("meeting_id", room.chime_meeting_id)
        .is("left_at", null)
        .limit(1000);
      const seats = (seatRows ?? []) as Seat[];
      const abandoned = seats.filter((s) => seatIsAbandoned(s, now));
      for (const s of abandoned) {
        await chime.deleteAttendee(room.chime_meeting_id, s.attendee_id).catch(() => {});
        await sb.from("meeting_seats").update({ left_at: new Date().toISOString() }).eq("id", s.id).is("left_at", null);
      }
      const connected = seats.filter((s) => seatIsLive(s, now)).length;

      // The host must be around unless they let the team run the room alone.
      const { data: hostSeat } = await sb
        .from("meeting_seats")
        .select("last_seen_at, created_at")
        .eq("meeting_id", room.chime_meeting_id)
        .eq("role", "host")
        .order("last_seen_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      const { data: firstSeat } = await sb
        .from("meeting_seats")
        .select("created_at")
        .eq("meeting_id", room.chime_meeting_id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      const openedMs = Date.parse(firstSeat?.created_at ?? room.updated_at ?? new Date().toISOString());
      const hostSeenMs = hostSeat?.last_seen_at ? Date.parse(hostSeat.last_seen_at) : null;
      if (hostAbsentTooLong({ teamCanStart: !!room.team_can_start, meetingOpenedMs: openedMs, hostLastSeenMs: hostSeenMs, nowMs: now })) {
        await closeRoom(room);
        results.push({ room: room.id, action: "closed_host_absent" });
        continue;
      }

      if (!isMeetingBillable(room.owner_wallet, ADMIN_WALLET)) {
        results.push({ room: room.id, action: "free_admin_room", seats: connected, cleared: abandoned.length });
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

      const broadcasting = !!room.broadcast_pipeline_id;
      const rec = await recording.activeRecording(room.id);
      const recUsd = rec ? recordingMinuteUsd(rec.record_video, rec.take_notes) : 0;
      const minuteTxc = usdToTxc8(meetingMinuteUsd(connected, broadcasting) + recUsd, txcUsd);
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

      // Keep enough for the host's live stream if it's on, so a meeting can't knock it offline.
      const { data: liveCh } = await sb
        .from("live_channels")
        .select("id")
        .eq("owner_wallet", room.owner_wallet)
        .in("status", ["starting", "running"])
        .limit(1)
        .maybeSingle();
      const liveRate = liveCh ? await credits.getWalletRatePerMin(room.owner_wallet).catch(() => 0) : 0;

      if (shouldEndForCredit(balance, minuteTxc)) {
        await closeRoom(room);
        results.push({ room: room.id, action: "ended_out_of_credit", seats: connected, balance });
      } else if (shouldEndForLiveReserve(balance, !!liveCh, liveRate)) {
        await closeRoom(room);
        results.push({ room: room.id, action: "ended_live_reserve", seats: connected, balance });
      } else {
        results.push({ room: room.id, action: "billed", seats: connected, cleared: abandoned.length, broadcasting, recording: !!rec, minuteTxc, balance });
      }
    } catch (err) {
      results.push({ room: room.id, action: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { considered: rooms?.length ?? 0, results };
}
