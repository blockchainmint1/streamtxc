import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const ADMIN_WALLET = "TeiqbqMxQG4JrDfrzdvTZcqhhai8KT5JTc";

function isAdmin(wallet: string | null | undefined) {
  return !!wallet && wallet === ADMIN_WALLET;
}

// ---------- Public reads ----------

export const getActiveLiveStream = createServerFn({ method: "GET" })
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("live_streams")
      .select("*")
      .in("status", ["starting", "live"])
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  });

export const listRecentLiveStreams = createServerFn({ method: "GET" })
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("live_streams")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listLiveChat = createServerFn({ method: "GET" })
  .inputValidator((input: { streamId: string }) => ({ streamId: String(input.streamId) }))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("live_chat_messages")
      .select("*")
      .eq("stream_id", data.streamId)
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

// ---------- Chat post (signed-in wallets) ----------

const PostChatSchema = z.object({
  streamId: z.string().uuid(),
  wallet: z.string().min(4).max(120),
  body: z.string().trim().min(1).max(500),
});

export const postLiveChat = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => PostChatSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("live_chat_messages").insert({
      stream_id: data.streamId,
      wallet: data.wallet,
      body: data.body,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- Admin: create / update / start / stop ----------

const CreateSchema = z.object({
  wallet: z.string(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  thumbnail_cid: z.string().trim().max(120).optional().nullable(),
  scheduled_for: z.string().optional().nullable(),
  simulcast_youtube_url: z.string().url().optional().nullable().or(z.literal("")),
  simulcast_twitter_url: z.string().url().optional().nullable().or(z.literal("")),
  simulcast_facebook_url: z.string().url().optional().nullable().or(z.literal("")),
});

export const createLiveStream = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CreateSchema.parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const hls = process.env.LIVE_HLS_URL ?? null;
    const channel = process.env.MEDIALIVE_CHANNEL_ID ?? null;
    const { data: row, error } = await supabaseAdmin
      .from("live_streams")
      .insert({
        title: data.title,
        description: data.description || null,
        thumbnail_cid: data.thumbnail_cid || null,
        scheduled_for: data.scheduled_for || null,
        simulcast_youtube_url: data.simulcast_youtube_url || null,
        simulcast_twitter_url: data.simulcast_twitter_url || null,
        simulcast_facebook_url: data.simulcast_facebook_url || null,
        owner_wallet: data.wallet,
        medialive_channel_id: channel,
        hls_url: hls,
        status: "scheduled",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

const UpdateSchema = z.object({
  wallet: z.string(),
  id: z.string().uuid(),
  patch: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    thumbnail_cid: z.string().trim().max(120).nullable().optional(),
    scheduled_for: z.string().nullable().optional(),
    simulcast_youtube_url: z.string().nullable().optional(),
    simulcast_twitter_url: z.string().nullable().optional(),
    simulcast_facebook_url: z.string().nullable().optional(),
  }),
});

export const updateLiveStream = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => UpdateSchema.parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("live_streams")
      .update(data.patch)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const IdSchema = z.object({ wallet: z.string(), id: z.string().uuid() });

export const startLiveStream = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { startChannel, describeChannel } = await import("./aws-medialive.server");

    // Only start if idle; otherwise treat as already-running.
    const current = await describeChannel().catch(() => null);
    if (current && current.state !== "RUNNING" && current.state !== "STARTING") {
      await startChannel();
    }
    const { error } = await supabaseAdmin
      .from("live_streams")
      .update({
        status: "starting",
        started_at: new Date().toISOString(),
        hls_url: process.env.LIVE_HLS_URL ?? null,
        medialive_channel_id: process.env.MEDIALIVE_CHANNEL_ID ?? null,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    // Fire-and-forget notifications
    try {
      await notifyGoLive(data.id);
    } catch (err) {
      console.warn("[live] notify failed", err);
    }

    return { ok: true };
  });

export const markLiveStreamRunning = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("live_streams")
      .update({ status: "live" })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const stopLiveStream = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { stopChannel } = await import("./aws-medialive.server");
    try {
      await stopChannel();
    } catch (err) {
      console.warn("[live] stopChannel failed (may already be idle)", err);
    }
    const { error } = await supabaseAdmin
      .from("live_streams")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const describeMediaLiveChannel = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ wallet: z.string() }).parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { describeChannel } = await import("./aws-medialive.server");
    const info = await describeChannel();
    return { state: info.state };
  });

// ---------- Notifications ----------

async function notifyGoLive(streamId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { sendTelegramMessage, sendAppEmail } = await import("./notifications.server");

  const { data: stream } = await supabaseAdmin
    .from("live_streams")
    .select("id, title, description")
    .eq("id", streamId)
    .maybeSingle();
  if (!stream) return;

  const url = "https://streamtxc.com/live";
  const tgText =
    `🔴 <b>LIVE NOW on streamTXC</b>\n\n` +
    `<b>${escapeHtml(stream.title)}</b>\n` +
    (stream.description ? `${escapeHtml(stream.description)}\n\n` : "\n") +
    `Watch: ${url}`;

  const { data: prefs } = await (supabaseAdmin as any)
    .from("wallet_notification_prefs")
    .select("email, email_verified_at, telegram_chat_id, notify_expiry")
    .eq("notify_expiry", true);

  for (const p of prefs ?? []) {
    if (p.telegram_chat_id) {
      await sendTelegramMessage(p.telegram_chat_id, tgText).catch(() => null);
    }
    if (p.email && p.email_verified_at) {
      await sendAppEmail({
        templateName: "live-stream-starting",
        recipientEmail: p.email,
        templateData: { title: stream.title, url },
        idempotencyKey: `live-${streamId}-${p.email}`,
      }).catch(() => null);
    }
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}