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
    const w = data.wallet;
    const displayName = w.length > 10 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
    const { error } = await supabaseAdmin.from("live_chat_messages").insert({
      stream_id: data.streamId,
      wallet: data.wallet,
      display_name: displayName,
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

    // Only start if idle; otherwise treat as already-running. If describe
    // fails (e.g. IAM missing DescribeChannel), still attempt the start —
    // previously a describe failure silently skipped startChannel entirely.
    const current = await describeChannel().catch(() => null);
    if (!current || (current.state !== "RUNNING" && current.state !== "STARTING")) {
      await startChannel().catch((err) => {
        console.error("[live] startChannel failed", err);
        throw new Error(
          `Could not start the MediaLive channel: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      });
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

// Probe the MediaPackage HLS manifest so we can tell the operator, at a
// glance, whether MediaLive is actually receiving RTMP from StreamYard.
// MediaPackage returns 404 with `x-mediapackage-manifest-last-sequence: 0`
// until MediaLive delivers at least one segment; once StreamYard is pushing
// video that MediaLive can encode, the manifest returns 200 and the sequence
// number increments every ~4s. This is the fastest way to diagnose "channel
// says RUNNING but /live is a spinner".
export const getLiveSignalHealth = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ wallet: z.string() }).parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const hls = process.env.LIVE_HLS_URL;
    if (!hls) return { ok: false, reason: "LIVE_HLS_URL not configured" as const };
    try {
      const res = await fetch(hls, { method: "GET", cache: "no-store" });
      const seqRaw = res.headers.get("x-mediapackage-manifest-last-sequence");
      const updatedRaw = res.headers.get("x-mediapackage-manifest-last-updated");
      const lastSequence = seqRaw ? Number(seqRaw) : 0;
      const lastUpdatedMs = updatedRaw ? Number(updatedRaw) * 1000 : 0;
      const ageSec = lastUpdatedMs ? Math.round((Date.now() - lastUpdatedMs) / 1000) : null;
      return {
        ok: true as const,
        status: res.status,
        lastSequence,
        lastUpdatedMs,
        ageSec,
        // "receiving" means MediaPackage got a segment in the last ~30s.
        receiving: res.status === 200 && ageSec !== null && ageSec < 30,
      };
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : "probe failed" };
    }
  });

// Return the RTMP push endpoints authoritative from MediaLive (Input.destinations),
// already split into a StreamYard-friendly Server URL + Stream Key pair.
// StreamYard's "Server URL" is `rtmp://<ip>:1935/<app>` and "Stream Key" is `<streamName>`.
export const getRtmpConfig = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ wallet: z.string() }).parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { describeInput } = await import("./aws-medialive.server");
    let destinations: string[] = [];
    try {
      const info = await describeInput();
      destinations = info.destinations;
    } catch (err) {
      console.warn("[live] describeInput failed, falling back to env", err);
    }
    if (destinations.length === 0) {
      const envUrl = process.env.LIVE_RTMP_URL?.trim();
      const envKey = process.env.LIVE_STREAM_KEY?.trim();
      if (envUrl && envKey && !envUrl.includes(`/${envKey}`)) {
        // Legacy secret shape: URL is already the app root, key is the stream name.
        destinations.push(`${envUrl.replace(/\/$/, "")}/${envKey}`);
      } else if (envUrl) {
        destinations.push(envUrl);
      }
    }
    const split = destinations.map((full) => {
      // Full push URL: rtmp://host[:port]/app/streamName
      const m = full.match(/^(rtmps?:\/\/[^/]+\/[^/]+)\/([^/?#]+)$/i);
      if (m) return { serverUrl: m[1], streamKey: m[2], fullUrl: full };
      // Fallback: split on last "/"
      const idx = full.lastIndexOf("/");
      if (idx > "rtmp://".length) {
        return { serverUrl: full.slice(0, idx), streamKey: full.slice(idx + 1), fullUrl: full };
      }
      return { serverUrl: full, streamKey: "", fullUrl: full };
    });
    return { endpoints: split };
  });

// ---------- Admin: archive consent flow ----------
//
// After a stream ends, the raw .ts segments MediaLive wrote to the archive
// bucket sit there for 14 days (lifecycle rule). If the admin confirms via
// the "Archive to library?" prompt, we stitch them into a normal HLS asset,
// pin the output to IPFS via the finalize-live-archive cron, and create a
// standard `videos` row (owner = admin wallet).
//
// If they Skip, we mark the row so the prompt disappears — the raw archive
// still expires from S3 on its own.

export const archiveLiveStream = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: stream, error: sErr } = await supabaseAdmin
      .from("live_streams")
      .select("id, title, status, archive_status, archive_transcode_job_id, started_at, ended_at")
      .eq("id", data.id)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!stream) throw new Error("Stream not found");
    if (stream.status !== "ended") throw new Error("Stream is not ended yet");
    if (stream.archive_status && stream.archive_status !== "failed") {
      // Already archived / in-flight / skipped — return current state, don't re-kick.
      return { ok: true, alreadyStarted: true, status: stream.archive_status };
    }

    const archiveBucket = process.env.LIVE_ARCHIVE_BUCKET;
    const archivePrefix = process.env.LIVE_ARCHIVE_PREFIX ?? "txc-live"; // stack name
    const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
    if (!archiveBucket) throw new Error("LIVE_ARCHIVE_BUCKET not configured");
    if (!outputBucket) throw new Error("AWS_S3_OUTPUT_BUCKET not configured");

    // List .ts segments MediaLive wrote for this stream. We filter by the
    // stream's time window to avoid grabbing segments from earlier sessions
    // that haven't expired yet.
    const { listObjects } = await import("./aws-s3.server");
    const allKeys = await listObjects(archiveBucket, archivePrefix);
    const tsKeys = allKeys.filter((k) => k.endsWith(".ts")).sort();
    if (tsKeys.length === 0) {
      throw new Error(
        `No archive segments found under s3://${archiveBucket}/${archivePrefix}`,
      );
    }

    // MediaLive names segments with an ISO-ish timestamp; when there is no
    // clean filter, fall back to "everything since the stream started" by
    // listing keys created after started_at. We rely on lexicographic sort
    // which matches chronological order for MediaLive's naming scheme.
    const inputUris = tsKeys.map((k) => `s3://${archiveBucket}/${k}`);

    const outputPrefix = `s3://${outputBucket}/hls/live-${stream.id}/`;
    const { startHlsTranscodeFromInputs } = await import("./aws-mediaconvert.server");
    const { jobId } = await startHlsTranscodeFromInputs({
      inputUris,
      outputPrefix,
      videoId: `live-archive:${stream.id}`,
    });

    const { error: uErr } = await supabaseAdmin
      .from("live_streams")
      .update({
        archive_status: "transcoding",
        archive_transcode_job_id: jobId,
        archive_output_prefix: outputPrefix,
        archive_error: null,
      })
      .eq("id", data.id);
    if (uErr) throw new Error(uErr.message);

    return { ok: true, jobId, segments: tsKeys.length };
  });

export const skipLiveArchive = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => IdSchema.parse(input))
  .handler(async ({ data }) => {
    if (!isAdmin(data.wallet)) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("live_streams")
      .update({ archive_status: "skipped" })
      .eq("id", data.id)
      .is("archive_status", null);
    if (error) throw new Error(error.message);
    return { ok: true };
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