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
  cleanDisplayName,
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

function roomView(room: Room, live: boolean, waitingCount: number) {
  return {
    id: room.id,
    title: room.title,
    purpose: room.purpose ?? "",
    joinCode: room.join_code,
    viewCode: room.view_code,
    joinSound: room.join_sound,
    approveTeam: room.approve_team,
    approveViewers: room.approve_viewers,
    live,
    broadcasting: live && !!room.broadcast_pipeline_id,
    broadcastStartedAt: room.broadcast_started_at,
    waitingCount,
  };
}

async function freshWaiting(roomIds: string[]) {
  if (!roomIds.length) return [] as Array<{ id: string; room_id: string; role: string; display_name: string; created_at: string }>;
  const sb = await db();
  const { data } = await sb
    .from("meeting_join_requests")
    .select("id, room_id, role, display_name, created_at")
    .in("room_id", roomIds)
    .eq("status", "waiting")
    .gt("last_seen_at", new Date(Date.now() - WAITING_STALE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(200);
  return (data ?? []) as Array<{ id: string; room_id: string; role: string; display_name: string; created_at: string }>;
}

async function insertRoom(wallet: string, title: string, purpose: string | null) {
  const sb = await db();
  const { data, error } = await sb
    .from("meeting_rooms")
    .insert({ owner_wallet: wallet, title, purpose, join_code: newMeetingCode(), view_code: newMeetingCode() })
    .select("*")
    .single();
  if (error) throw new Error("Could not create the meeting room.");
  return data as Room;
}

// ---------- Host ----------

export const listMyMeetingRooms = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    await assertCanHost(context.wallet);
    const sb = await db();
    const { data } = await sb
      .from("meeting_rooms")
      .select("*")
      .eq("owner_wallet", context.wallet)
      .is("archived_at", null)
      .order("created_at", { ascending: true });
    let rooms = (data ?? []) as Room[];
    if (!rooms.length) rooms = [await insertRoom(context.wallet, "Daily team meeting", null)];
    const [lives, waiting, billing] = await Promise.all([
      Promise.all(rooms.map(isMeetingLive)),
      freshWaiting(rooms.map((r) => r.id)),
      meetingBilling(context.wallet),
    ]);
    return {
      billing,
      rooms: rooms.map((r, i) => roomView(r, lives[i], waiting.filter((w) => w.room_id === r.id).length)),
    };
  });

const RoomId = z.object({ roomId: z.string().uuid() });

export const createMeetingRoom = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) =>
    z.object({ title: z.string().min(1).max(120), purpose: z.string().max(300).optional() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertCanHost(context.wallet);
    const title = cleanRoomTitle(data.title);
    if (!title) throw new Error("Give the meeting a name.");
    const sb = await db();
    const { count } = await sb
      .from("meeting_rooms")
      .select("id", { count: "exact", head: true })
      .eq("owner_wallet", context.wallet)
      .is("archived_at", null);
    if ((count ?? 0) >= MAX_ROOMS_PER_HOST) throw new Error(`You can have up to ${MAX_ROOMS_PER_HOST} meeting rooms.`);
    const purpose = data.purpose?.trim().slice(0, 300) || null;
    const room = await insertRoom(context.wallet, title, purpose);
    return { id: room.id };
  });

export const updateMeetingRoom = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) =>
    RoomId.extend({
      title: z.string().min(1).max(120).optional(),
      purpose: z.string().max(300).optional(),
      joinSound: z.boolean().optional(),
      approveTeam: z.boolean().optional(),
      approveViewers: z.boolean().optional(),
      rotateLinks: z.boolean().optional(),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertCanHost(context.wallet);
    const room = await ownedRoom(context.wallet, data.roomId);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.title !== undefined) {
      const t = cleanRoomTitle(data.title);
      if (!t) throw new Error("Give the meeting a name.");
      patch.title = t;
    }
    if (data.purpose !== undefined) patch.purpose = data.purpose.trim().slice(0, 300) || null;
    if (data.joinSound !== undefined) patch.join_sound = data.joinSound;
    if (data.approveTeam !== undefined) patch.approve_team = data.approveTeam;
    if (data.approveViewers !== undefined) patch.approve_viewers = data.approveViewers;
    if (data.rotateLinks) {
      patch.join_code = newMeetingCode();
      patch.view_code = newMeetingCode();
    }
    const sb = await db();
    const { error } = await sb.from("meeting_rooms").update(patch).eq("id", room.id);
    if (error) throw new Error("Could not save the meeting settings.");
    return { ok: true };
  });

async function closeMeeting(room: Room) {
  const chime = await import("./aws-chime.server");
  if (room.broadcast_pipeline_id) await chime.stopMediaPipeline(room.broadcast_pipeline_id).catch(() => {});
  if (room.chime_meeting_id) await chime.deleteMeeting(room.chime_meeting_id);
  const sb = await db();
  await sb
    .from("meeting_rooms")
    .update({ chime_meeting_id: null, chime_meeting: null, broadcast_pipeline_id: null, broadcast_started_at: null })
    .eq("id", room.id);
  await sb.from("meeting_join_requests").update({ status: "denied", decided_at: new Date().toISOString() })
    .eq("room_id", room.id).in("status", ["waiting", "admitted"]);
}

export const endMeeting = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) => RoomId.parse(i))
  .handler(async ({ data, context }) => {
    await closeMeeting(await ownedRoom(context.wallet, data.roomId));
    return { ok: true };
  });

export const deleteMeetingRoom = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) => RoomId.parse(i))
  .handler(async ({ data, context }) => {
    const room = await ownedRoom(context.wallet, data.roomId);
    await closeMeeting(room);
    const sb = await db();
    // Kept for the billing history, but its links stop working immediately.
    await sb.from("meeting_rooms").update({ archived_at: new Date().toISOString() }).eq("id", room.id);
    return { ok: true };
  });

export const listJoinRequests = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) => RoomId.parse(i))
  .handler(async ({ data, context }) => {
    const room = await ownedRoom(context.wallet, data.roomId);
    const rows = await freshWaiting([room.id]);
    return rows.map((r) => ({ id: r.id, name: r.display_name, role: r.role as "participant" | "viewer", since: r.created_at }));
  });

export const decideJoinRequest = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) =>
    RoomId.extend({ requestIds: z.array(z.string().uuid()).min(1).max(100), admit: z.boolean() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const room = await ownedRoom(context.wallet, data.roomId);
    const sb = await db();
    const { data: rows } = await sb
      .from("meeting_join_requests")
      .update({ status: data.admit ? "admitted" : "denied", decided_at: new Date().toISOString() })
      .eq("room_id", room.id)
      .eq("status", "waiting")
      .in("id", data.requestIds)
      .select("id");
    return { updated: (rows ?? []).length };
  });

/** RTMP push address of the host's AWS live channel (the same one StreamYard uses). */
async function hostRtmpTarget(wallet: string): Promise<{ url: string; channelId?: string }> {
  const ml = await import("./aws-medialive.server");
  if (wallet === ADMIN_WALLET) {
    const info = await ml.describeInput().catch(() => ({ destinations: [] as string[] }));
    let url: string | undefined = info.destinations[0];
    if (!url) {
      const envUrl = process.env.LIVE_RTMP_URL?.trim();
      const envKey = process.env.LIVE_STREAM_KEY?.trim();
      url = envUrl && envKey && !envUrl.includes(`/${envKey}`) ? `${envUrl.replace(/\/$/, "")}/${envKey}` : envUrl;
    }
    if (!url) throw new Error("No live stream address is set up for this account.");
    return { url };
  }
  const sb = await db();
  const { data: ch } = await sb
    .from("live_channels")
    .select("rtmp_url, stream_key, medialive_channel_id")
    .eq("owner_wallet", wallet)
    .maybeSingle();
  if (!ch?.rtmp_url) throw new Error("Set up your live channel on the Manage page first.");
  const base = String(ch.rtmp_url).replace(/\/$/, "");
  const url = ch.stream_key && !base.endsWith(`/${ch.stream_key}`) ? `${base}/${ch.stream_key}` : base;
  return { url, channelId: ch.medialive_channel_id ?? undefined };
}

export const startMeetingBroadcast = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) => RoomId.parse(i))
  .handler(async ({ data, context }) => {
    await assertCanHost(context.wallet);
    const room = await ownedRoom(context.wallet, data.roomId);
    if (!room.chime_meeting_id) throw new Error("Start the meeting first, then send it to your live stream.");
    if (room.broadcast_pipeline_id) return { ok: true, already: true };
    const sb = await db();
    // One live channel per host → only one room can be on it at a time.
    const { data: other } = await sb
      .from("meeting_rooms")
      .select("title")
      .eq("owner_wallet", context.wallet)
      .neq("id", room.id)
      .not("broadcast_pipeline_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (other) throw new Error(`"${other.title}" is already on your live stream. Stop it there first.`);
    const chime = await import("./aws-chime.server");
    const meeting = await chime.getMeeting(room.chime_meeting_id);
    if (!meeting?.MeetingArn) throw new Error("The meeting has ended — join again to restart it.");
    const target = await hostRtmpTarget(context.wallet);
    const ml = await import("./aws-medialive.server");
    const state = await ml.describeChannel(target.channelId).catch(() => null);
    if (state?.state !== "RUNNING") {
      throw new Error("Your live stream isn't ready. On the Manage page, warm it up until the light is green, then try again.");
    }
    let pipelineId: string;
    try {
      ({ pipelineId } = await chime.startLiveConnector({
        meetingArn: meeting.MeetingArn,
        rtmpUrl: target.url,
        token: `${room.id}-${room.meeting_generation}-bc-${Date.now()}`.slice(0, 64),
      }));
    } catch (err) {
      throw new Error(err instanceof Error && /permission/i.test(err.message)
        ? "AWS permission for sending meetings to the live stream is missing."
        : "AWS couldn't start sending the meeting to your live stream. Try again in a minute.");
    }
    await sb
      .from("meeting_rooms")
      .update({ broadcast_pipeline_id: pipelineId, broadcast_started_at: new Date().toISOString() })
      .eq("id", room.id);
    return { ok: true, already: false };
  });

export const stopMeetingBroadcast = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) => RoomId.parse(i))
  .handler(async ({ data, context }) => {
    const room = await ownedRoom(context.wallet, data.roomId);
    if (!room.broadcast_pipeline_id) return { ok: true };
    const chime = await import("./aws-chime.server");
    await chime.stopMediaPipeline(room.broadcast_pipeline_id);
    const sb = await db();
    await sb.from("meeting_rooms").update({ broadcast_pipeline_id: null, broadcast_started_at: null }).eq("id", room.id);
    return { ok: true };
  });

// ---------- Anyone with a link ----------

const CodeSchema = z.object({ code: z.string().regex(MEETING_CODE_RE) });

export const getMeetingInfo = createServerFn({ method: "POST" })
  .middleware([optionalWalletSession])
  .inputValidator((i: unknown) => CodeSchema.parse(i))
  .handler(async ({ data, context }) => {
    const room = await roomByCode(data.code);
    const role = room ? roleForCode(room, data.code, context.wallet) : null;
    if (!room || !role) return { found: false as const };
    return {
      found: true as const,
      title: room.title,
      purpose: room.purpose ?? "",
      role,
      live: await isMeetingLive(room),
      needsApproval: needsApproval(room, role),
    };
  });

/** Gives this person a seat in the room's meeting and returns what their browser needs. */
async function seat(found: Room, role: "host" | "participant" | "viewer", name: string, allowCreate: boolean) {
  const room = await ensureMeeting(found, allowCreate);
  const chime = await import("./aws-chime.server");
  const rand = crypto.randomUUID().replace(/-/g, "");
  const attendee = await chime.createAttendee(room.chime_meeting_id!, encodeExternalUserId(role, name, rand), capabilitiesFor(role));
  const sb = await db();
  await sb.from("meeting_rooms").update({ last_joined_at: new Date().toISOString() }).eq("id", room.id);
  const m = room.chime_meeting;
  const { signLeaveToken } = await import("./meeting-leave");
  const leaveSecret = process.env.MEETING_LEAVE_SECRET;
  const leaveToken = leaveSecret ? await signLeaveToken(leaveSecret, m.MeetingId, attendee.AttendeeId) : null;
  return {
    status: "joined" as const,
    leaveToken,
    role,
    roomId: role === "host" ? room.id : null,
    title: room.title,
    joinSound: room.join_sound,
    meeting: { MeetingId: m.MeetingId, MediaRegion: m.MediaRegion, MediaPlacement: m.MediaPlacement, ExternalMeetingId: m.ExternalMeetingId },
    attendee,
  };
}

export const joinMeeting = createServerFn({ method: "POST" })
  .middleware([optionalWalletSession])
  .inputValidator((i: unknown) =>
    CodeSchema.extend({ name: z.string().trim().min(1).max(60) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const found = await roomByCode(data.code);
    const role = found ? roleForCode(found, data.code, context.wallet) : null;
    if (!found || !role) throw new Error("This meeting link isn't valid anymore. Ask the host for a new one.");
    if (needsApproval(found, role)) {
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const sb = await db();
      const { data: req, error } = await sb
        .from("meeting_join_requests")
        .insert({ room_id: found.id, role, display_name: cleanDisplayName(data.name), token_hash: await sha256Hex(token) })
        .select("id")
        .single();
      if (error) throw new Error("Couldn't ask the host to let you in. Please try again.");
      return { status: "waiting" as const, requestId: req.id as string, token };
    }
    try {
      return await seat(found, role, data.name, role !== "viewer");
    } catch (err) {
      throw new Error(friendly(err));
    }
  });

/** Polled by a waiting guest. Once the host admits them, this hands out their seat exactly once. */
export const checkJoinRequest = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) =>
    z.object({ requestId: z.string().uuid(), token: z.string().regex(/^[0-9a-f]{64}$/) }).parse(i),
  )
  .handler(async ({ data }) => {
    const sb = await db();
    const hash = await sha256Hex(data.token);
    const { data: req } = await sb
      .from("meeting_join_requests")
      .select("id, room_id, role, display_name, status")
      .eq("id", data.requestId)
      .eq("token_hash", hash)
      .maybeSingle();
    if (!req) return { status: "denied" as const };
    if (req.status === "waiting") {
      await sb.from("meeting_join_requests").update({ last_seen_at: new Date().toISOString() }).eq("id", req.id);
      return { status: "waiting" as const };
    }
    if (req.status !== "admitted") return { status: "denied" as const };
    // Claim the admission so a copied token can't mint extra seats.
    const { data: claimed } = await sb
      .from("meeting_join_requests")
      .update({ status: "joined" })
      .eq("id", req.id)
      .eq("status", "admitted")
      .select("id")
      .maybeSingle();
    if (!claimed) return { status: "denied" as const };
    const { data: room } = await sb.from("meeting_rooms").select("*").eq("id", req.room_id).is("archived_at", null).maybeSingle();
    if (!room) return { status: "denied" as const };
    try {
      return await seat(room as Room, req.role, req.display_name, true);
    } catch (err) {
      await sb.from("meeting_join_requests").update({ status: "admitted" }).eq("id", req.id);
      throw new Error(friendly(err));
    }
  });
