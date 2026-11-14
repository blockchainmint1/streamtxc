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
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Could not look up that meeting.");
  return data as Room | null;
}

async function roomForOwner(wallet: string): Promise<Room | null> {
  const sb = await db();
  const { data } = await sb.from("meeting_rooms").select("*").eq("owner_wallet", wallet).maybeSingle();
  return data as Room | null;
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  if (/permission is missing/i.test(msg)) return "Meetings aren't switched on yet — the host still needs to finish the AWS setup.";
  return "The meeting service didn't respond. Please try again in a moment.";
}

/** Returns the room's live Chime meeting, creating a new one if the last one ended. */
async function ensureMeeting(room: Room): Promise<Room> {
  const chime = await import("./aws-chime.server");
  if (room.chime_meeting_id) {
    const live = await chime.getMeeting(room.chime_meeting_id);
    if (live) return { ...room, chime_meeting: live };
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

function hostView(room: Room, live: boolean) {
  return {
    title: room.title,
    joinCode: room.join_code,
    viewCode: room.view_code,
    live,
    broadcasting: live && !!room.broadcast_pipeline_id,
    broadcastStartedAt: room.broadcast_started_at,
  };
}

// ---------- Host ----------

export const getMyMeetingRoom = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    await assertCanHost(context.wallet);
    let room = await roomForOwner(context.wallet);
    if (!room) {
      const sb = await db();
      const { data, error } = await sb
        .from("meeting_rooms")
        .insert({ owner_wallet: context.wallet, join_code: newMeetingCode(), view_code: newMeetingCode() })
        .select("*")
        .single();
      if (error) throw new Error("Could not create your meeting room.");
      room = data as Room;
    }
    return hostView(room, await isMeetingLive(room));
  });

export const updateMyMeetingRoom = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) =>
    z.object({ title: z.string().trim().min(1).max(80).optional(), rotateLinks: z.boolean().optional() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    await assertCanHost(context.wallet);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.title) patch.title = data.title;
    if (data.rotateLinks) {
      patch.join_code = newMeetingCode();
      patch.view_code = newMeetingCode();
    }
    const sb = await db();
    const { data: row, error } = await sb
      .from("meeting_rooms")
      .update(patch)
      .eq("owner_wallet", context.wallet)
      .select("*")
      .single();
    if (error) throw new Error("Could not update your meeting room.");
    return hostView(row as Room, await isMeetingLive(row as Room));
  });

export const endMyMeeting = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const room = await roomForOwner(context.wallet);
    if (!room) return { ok: true };
    const chime = await import("./aws-chime.server");
    if (room.broadcast_pipeline_id) await chime.stopMediaPipeline(room.broadcast_pipeline_id).catch(() => {});
    if (room.chime_meeting_id) await chime.deleteMeeting(room.chime_meeting_id);
    const sb = await db();
    await sb
      .from("meeting_rooms")
      .update({ chime_meeting_id: null, chime_meeting: null, broadcast_pipeline_id: null, broadcast_started_at: null })
      .eq("id", room.id);
    return { ok: true };
  });

/** RTMP push address of the host's AWS live channel (the same one StreamYard uses). */
async function hostRtmpTarget(wallet: string): Promise<{ url: string; channelId?: string }> {
  const ml = await import("./aws-medialive.server");
  if (wallet === ADMIN_WALLET) {
    const info = await ml.describeInput().catch(() => ({ destinations: [] as string[] }));
    let url = info.destinations[0];
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
  .handler(async ({ context }) => {
    await assertCanHost(context.wallet);
    const room = await roomForOwner(context.wallet);
    if (!room?.chime_meeting_id) throw new Error("Start the meeting first, then send it to your live stream.");
    const chime = await import("./aws-chime.server");
    const meeting = await chime.getMeeting(room.chime_meeting_id);
    if (!meeting?.MeetingArn) throw new Error("The meeting has ended — join again to restart it.");
    if (room.broadcast_pipeline_id) return { ok: true, already: true };
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
    const sb = await db();
    await sb
      .from("meeting_rooms")
      .update({ broadcast_pipeline_id: pipelineId, broadcast_started_at: new Date().toISOString() })
      .eq("id", room.id);
    return { ok: true, already: false };
  });

export const stopMeetingBroadcast = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const room = await roomForOwner(context.wallet);
    if (!room?.broadcast_pipeline_id) return { ok: true };
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
    return { found: true as const, title: room.title, role, live: await isMeetingLive(room) };
  });

export const joinMeeting = createServerFn({ method: "POST" })
  .middleware([optionalWalletSession])
  .inputValidator((i: unknown) =>
    CodeSchema.extend({ name: z.string().trim().min(1).max(60) }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const found = await roomByCode(data.code);
    const role = found ? roleForCode(found, data.code, context.wallet) : null;
    if (!found || !role) throw new Error("This meeting link isn't valid anymore. Ask the host for a new one.");
    try {
      const room = await ensureMeeting(found);
      const chime = await import("./aws-chime.server");
      const rand = crypto.randomUUID().replace(/-/g, "");
      const attendee = await chime.createAttendee(
        room.chime_meeting_id!,
        encodeExternalUserId(role, data.name, rand),
        capabilitiesFor(role),
      );
      const sb = await db();
      await sb.from("meeting_rooms").update({ last_joined_at: new Date().toISOString() }).eq("id", room.id);
      const m = room.chime_meeting;
      return {
        role,
        title: room.title,
        meeting: { MeetingId: m.MeetingId, MediaRegion: m.MediaRegion, MediaPlacement: m.MediaPlacement, ExternalMeetingId: m.ExternalMeetingId },
        attendee,
      };
    } catch (err) {
      throw new Error(friendly(err));
    }
  });
