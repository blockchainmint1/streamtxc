// Server functions for the HLS transcode pipeline.
//
// Flow (client-side orchestration in upload.tsx):
//   1. Pin original to self-hosted IPFS (existing /api/public/upload).
//   2. Call `getTranscodeUploadUrl({ cid, contentType })` → presigned S3 PUT.
//   3. Browser PUTs the same file to S3.
//   4. Call `startTranscode({ cid })` → kicks off MediaConvert, sets
//      videos.transcode_status = 'processing'.
//   5. EventBridge → /api/public/hooks/mediaconvert pins outputs + updates row.
//
// `isTranscodeConfigured()` lets the UI skip steps 2–4 cleanly if AWS env
// vars aren't set yet, so legacy single-MP4 playback keeps working.

import { createServerFn } from "@tanstack/react-start";

function transcodeEnv() {
  return {
    inputBucket: process.env.AWS_S3_INPUT_BUCKET,
    outputBucket: process.env.AWS_S3_OUTPUT_BUCKET,
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    role: process.env.AWS_MEDIACONVERT_ROLE_ARN,
    endpoint: process.env.AWS_MEDIACONVERT_ENDPOINT,
  };
}

export const isTranscodeConfigured = createServerFn({ method: "GET" }).handler(
  async () => {
    const e = transcodeEnv();
    return {
      configured: Boolean(
        e.inputBucket && e.outputBucket && e.region &&
        e.accessKeyId && e.secretAccessKey && e.role && e.endpoint,
      ),
    };
  },
);

/**
 * Public server fn: pull a video's bytes from IPFS (gateway → S3 input
 * bucket) and kick off MediaConvert. Idempotent — backfillOneHls bails
 * early if the row already has hls_cid or is already in flight, so
 * accidental re-calls don't double-bill MediaConvert. Used by the URL
 * importers (Zoom, future Dropbox HLS) to start the transcode after
 * addByCid finishes.
 */
export const kickoffHlsFromCid = createServerFn({ method: "POST" })
  .inputValidator((d: { cid: string }) => {
    if (!d.cid || typeof d.cid !== "string" || d.cid.length > 200) {
      throw new Error("Invalid cid");
    }
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket || !e.outputBucket) {
      return { ok: false, reason: "transcode_not_configured" as const };
    }
    const { backfillOneHls } = await import("./backfill-hls.server");
    try {
      const r = await backfillOneHls(data.cid);
      return { ok: true, jobId: r.jobId, mode: r.mode, bytes: r.bytes };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`kickoffHlsFromCid(${data.cid}) failed:`, msg);
      return { ok: false, reason: msg };
    }
  });

export const getTranscodeUploadUrl = createServerFn({ method: "POST" })
  .inputValidator((d: { cid: string; contentType: string }) => {
    if (!d.cid || d.cid.length > 200) throw new Error("Invalid cid");
    if (!d.contentType || d.contentType.length > 100) throw new Error("Invalid contentType");
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket) throw new Error("Transcode not configured");
    const { createPresignedPutUrl } = await import("./aws-s3.server");
    const key = `inputs/${data.cid}`;
    const url = await createPresignedPutUrl({
      bucket: e.inputBucket,
      key,
      contentType: data.contentType,
      expiresSeconds: 3600,
    });
    return { url, bucket: e.inputBucket, key };
  });

/**
 * Preflight: check whether the S3 input bucket already has bytes for this
 * CID at `inputs/<cid>`. Lets the browser skip a multi-GB re-upload when a
 * prior attempt already landed the file — the common case after a browser
 * tab reload, a spotty network, or a killed pin retry.
 *
 * Returns `{ exists: false }` when not present, or
 * `{ exists: true, key, bucket, size, contentType }` when present.
 */
export const checkS3InputExists = createServerFn({ method: "POST" })
  .inputValidator((d: { cid: string }) => {
    if (!d.cid || typeof d.cid !== "string" || d.cid.length > 200) {
      throw new Error("Invalid cid");
    }
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket) return { exists: false as const };
    const { headObject } = await import("./aws-s3.server");
    const key = `inputs/${data.cid}`;
    const meta = await headObject(e.inputBucket, key);
    if (!meta) return { exists: false as const };
    return {
      exists: true as const,
      bucket: e.inputBucket,
      key,
      size: meta.size,
      contentType: meta.contentType,
    };
  });

export const startTranscode = createServerFn({ method: "POST" })
  .inputValidator((d: { cid: string }) => {
    if (!d.cid || d.cid.length > 200) throw new Error("Invalid cid");
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket || !e.outputBucket) throw new Error("Transcode not configured");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { startHlsTranscode } = await import("./aws-mediaconvert.server");

    const { data: video, error: vErr } = await supabaseAdmin
      .from("videos")
      .select("cid")
      .eq("cid", data.cid)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!video) throw new Error("Video not found");

    const { jobId } = await startHlsTranscode({
      inputUri: `s3://${e.inputBucket}/inputs/${data.cid}`,
      outputPrefix: `s3://${e.outputBucket}/hls/${data.cid}/`,
      videoId: data.cid,
    });

    await supabaseAdmin
      .from("videos")
      .update({
        transcode_status: "processing",
        transcode_job_id: jobId,
        transcode_started_at: new Date().toISOString(),
        transcode_error: null,
      })
      .eq("cid", data.cid);

    return { jobId };
  });

export const getTranscodeStatus = createServerFn({ method: "GET" })
  .inputValidator((d: { cid: string }) => {
    if (!d.cid || d.cid.length > 200) throw new Error("Invalid cid");
    return d;
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("videos")
      .select("transcode_status, transcode_job_id, transcode_error, transcode_started_at, hls_cid, renditions")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw error;
    return row ?? null;
  });


export const getMediaConvertJob = createServerFn({ method: "POST" })
  .inputValidator((d: { jobId: string }) => {
    if (!d.jobId || d.jobId.length > 200) throw new Error("Invalid jobId");
    return d;
  })
  .handler(async ({ data }) => {
    const { describeJob } = await import("./aws-mediaconvert.server");
    return await describeJob(data.jobId);
  });


