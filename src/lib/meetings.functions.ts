// /meet team meeting rooms on Amazon Chime SDK.
// Hosts are signed-in wallets (admin or livestream-enabled). Anyone holding the
// participant link joins with mic/camera/screen; the view-only link can only receive.
// Never trust an input wallet — always context.wallet.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession, optionalWalletSession } from "./wallet-auth.functions";
import {
  MEETING_CODE_RE,
  capabilitiesFor,
  encodeExternalUserId,
  newMeetingCode,
  roleForCode,
  needsApproval,
  cleanRoomTitle,
  MAX_ROOMS_PER_HOST,
  WAITING_STALE_MS,
  isMeetingBillable,
  usdToTxc8,
  MIN_START_SEAT_MINUTES,
  PRICE_USD_PER_SEAT_MINUTE,
  PRICE_USD_PER_BROADCAST_MINUTE,
} from "./meeting-rules";

const ADMIN_WALLET = "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m";

type Room = {
  id: string;
  owner_wallet: string;
  title: string;
  join_code: string;
  view_code: string;
  chime_meeting_id: string | null;
  chime_meeting: any;
  meeting_generation: number;
  broadcast_pipeline_id: string | null;
  broadcast_started_at: string | null;
  last_joined_at: string | null;
  purpose: string | null;
  join_sound: boolean;
  approve_team: boolean;
  approve_viewers: boolean;
  archived_at: string | null;
  created_at: string;
};

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

async function assertCanHost(wallet: string) {
  if (wallet === ADMIN_WALLET) return;
  const sb = await db();
  const { data } = await sb
    .from("wallet_notification_prefs")
    .select("live_eligible")
    .eq("wallet", wallet)
    .maybeSingle();
  if (!data?.live_eligible) throw new Error("Hosting meetings isn't turned on for this account.");
}

async function roomByCode(code: string): Promise<Room | null> {
  const sb = await db();
  const { data, error } = await sb
    .from("meeting_rooms")
    .select("*")
    .or(`join_code.eq.${code},view_code.eq.${code}`)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Could not look up that meeting.");
  return data as Room | null;
}

/** A room the signed-in host owns — never trust a room id without this check. */
async function ownedRoom(wallet: string, roomId: string): Promise<Room> {
  const sb = await db();
  const { data } = await sb
    .from("meeting_rooms")
    .select("*")
    .eq("id", roomId)
    .eq("owner_wallet", wallet)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) throw new Error("That meeting room wasn't found.");
  return data as Room;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class NotStartedError extends Error {}
class NoCreditError extends Error {}

/** Host's prepaid TXC balance (same balance as live streaming) and today's meeting prices in TXC. */
async function meetingBilling(wallet: string) {
  const { getTxcUsdPrice } = await import("./txc-price.server");
  const price = await getTxcUsdPrice();
  const billable = isMeetingBillable(wallet, ADMIN_WALLET);
  let balanceTxc = 0;
  if (billable) {
    const credits = await import("./live-credits.functions");
    await credits.syncDepositsForWallet(wallet).catch(() => null);
    balanceTxc = await credits.computeBalance(wallet);
  }
  return {
    billable,
    balanceTxc: +balanceTxc.toFixed(8),
    txcUsd: price.usd,
    seatMinuteUsd: PRICE_USD_PER_SEAT_MINUTE,
    broadcastMinuteUsd: PRICE_USD_PER_BROADCAST_MINUTE,
    seatMinuteTxc: usdToTxc8(PRICE_USD_PER_SEAT_MINUTE, price.usd),
    broadcastMinuteTxc: usdToTxc8(PRICE_USD_PER_BROADCAST_MINUTE, price.usd),
    minStartTxc: usdToTxc8(MIN_START_SEAT_MINUTES * PRICE_USD_PER_SEAT_MINUTE, price.usd),
  };
}

function friendly(err: unknown): string {
  if (err instanceof NotStartedError) return "The meeting hasn't started yet. This page will let you in as soon as it does.";
  if (err instanceof NoCreditError) return err.message;
  const msg = err instanceof Error ? err.message : "";
  if (/permission is missing/i.test(msg)) return "Meetings aren't switched on yet — the host still needs to finish the AWS setup.";
  return "The meeting service didn't respond. Please try again in a moment.";
}

/** Returns the room's live Chime meeting, creating a new one if the last one ended. */
async function ensureMeeting(room: Room, allowCreate: boolean): Promise<Room> {
  const chime = await import("./aws-chime.server");
  if (room.chime_meeting_id) {
    const live = await chime.getMeeting(room.chime_meeting_id);
    if (live) return { ...room, chime_meeting: live };
  }
  if (!allowCreate) throw new NotStartedError();
  if (isMeetingBillable(room.owner_wallet, ADMIN_WALLET)) {
    const b = await meetingBilling(room.owner_wallet);
    if (b.balanceTxc < b.minStartTxc) {
      throw new NoCreditError("The host's meeting balance is empty. The host can add TXC on the Manage page, then try again.");
    }
  }
  const gen = room.meeting_generation + 1;
  // Same token for everyone racing to restart this generation → AWS returns one meeting.
  const meeting = await chime.createMeeting({
    token: `${room.id}-${gen}`,
    externalId: `streamtxc-${room.id.slice(0, 8)}-${gen}`,
  });
  const sb = await db();
  const { data: updated } = await sb
    .from("meeting_rooms")
    .update({
      chime_meeting_id: meeting.MeetingId,
      chime_meeting: meeting,
      meeting_generation: gen,
      broadcast_pipeline_id: null,
      broadcast_started_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", room.id)
    .eq("meeting_generation", room.meeting_generation)
    .select("*")
    .maybeSingle();
  if (updated) return updated as Room;
  const { data: fresh } = await sb.from("meeting_rooms").select("*").eq("id", room.id).single();
  return fresh as Room;
}

async function isMeetingLive(room: Room): Promise<boolean> {
  if (!room.chime_meeting_id) return false;
  try {
    const chime = await import("./aws-chime.server");
    return !!(await chime.getMeeting(room.chime_meeting_id));
  } catch {
    return false;
  }
}

