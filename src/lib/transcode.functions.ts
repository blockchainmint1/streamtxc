// Server functions for the HLS transcode pipeline.
//
// Flow (client-side orchestration in upload.tsx):
//   1. Pin original to Pinata (existing /api/public/upload).
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

export const getPinataGateway = createServerFn({ method: "GET" }).handler(
  async () => ({ gateway: process.env.PINATA_GATEWAY_DOMAIN ?? null }),
);

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

// ---- Multipart upload server fns (for large files: >50MB recommended) -----

export const startMultipartUpload = createServerFn({ method: "POST" })
  .inputValidator((d: { cid: string; contentType: string }) => {
    if (!d.cid || d.cid.length > 200) throw new Error("Invalid cid");
    if (!d.contentType || d.contentType.length > 100) throw new Error("Invalid contentType");
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket) throw new Error("Transcode not configured");
    const { createMultipartUpload } = await import("./aws-s3.server");
    const key = `inputs/${data.cid}`;
    const { uploadId } = await createMultipartUpload({
      bucket: e.inputBucket,
      key,
      contentType: data.contentType,
    });
    return { uploadId, bucket: e.inputBucket, key };
  });

export const signMultipartPart = createServerFn({ method: "POST" })
  .inputValidator((d: { key: string; uploadId: string; partNumber: number }) => {
    if (!d.key || d.key.length > 500) throw new Error("Invalid key");
    if (!d.uploadId || d.uploadId.length > 500) throw new Error("Invalid uploadId");
    if (!Number.isInteger(d.partNumber) || d.partNumber < 1 || d.partNumber > 10000) {
      throw new Error("Invalid partNumber");
    }
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket) throw new Error("Transcode not configured");
    const { signMultipartPartUrl } = await import("./aws-s3.server");
    const url = await signMultipartPartUrl({
      bucket: e.inputBucket,
      key: data.key,
      uploadId: data.uploadId,
      partNumber: data.partNumber,
      expiresSeconds: 3600,
    });
    return { url };
  });

export const finishMultipartUpload = createServerFn({ method: "POST" })
  .inputValidator((d: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }) => {
    if (!d.key || d.key.length > 500) throw new Error("Invalid key");
    if (!d.uploadId || d.uploadId.length > 500) throw new Error("Invalid uploadId");
    if (!Array.isArray(d.parts) || d.parts.length === 0 || d.parts.length > 10000) {
      throw new Error("Invalid parts");
    }
    for (const p of d.parts) {
      if (!Number.isInteger(p.partNumber) || p.partNumber < 1) throw new Error("Invalid part");
      if (!p.etag || p.etag.length > 200) throw new Error("Invalid etag");
    }
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket) throw new Error("Transcode not configured");
    const { completeMultipartUpload } = await import("./aws-s3.server");
    await completeMultipartUpload({
      bucket: e.inputBucket,
      key: data.key,
      uploadId: data.uploadId,
      parts: data.parts,
    });
    return { ok: true };
  });

export const cancelMultipartUpload = createServerFn({ method: "POST" })
  .inputValidator((d: { key: string; uploadId: string }) => {
    if (!d.key || d.key.length > 500) throw new Error("Invalid key");
    if (!d.uploadId || d.uploadId.length > 500) throw new Error("Invalid uploadId");
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket) throw new Error("Transcode not configured");
    const { abortMultipartUpload } = await import("./aws-s3.server");
    await abortMultipartUpload({
      bucket: e.inputBucket,
      key: data.key,
      uploadId: data.uploadId,
    });
    return { ok: true };
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

// ---- Test helpers (used by /s3-test) ---------------------------------------
// These skip the DB lookup so we can exercise the AWS pipeline end-to-end
// without first inserting a `videos` row.

export const startTranscodeTest = createServerFn({ method: "POST" })
  .inputValidator((d: { key: string }) => {
    if (!d.key || d.key.length > 500) throw new Error("Invalid key");
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.inputBucket || !e.outputBucket) throw new Error("Transcode not configured");
    const { startHlsTranscode } = await import("./aws-mediaconvert.server");
    const id = data.key.split("/").pop() || `test-${Date.now()}`;
    const { jobId } = await startHlsTranscode({
      inputUri: `s3://${e.inputBucket}/${data.key}`,
      outputPrefix: `s3://${e.outputBucket}/hls/${id}/`,
      videoId: id,
    });
    return {
      jobId,
      inputUri: `s3://${e.inputBucket}/${data.key}`,
      outputPrefix: `s3://${e.outputBucket}/hls/${id}/`,
    };
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

export const listTranscodeOutputs = createServerFn({ method: "POST" })
  .inputValidator((d: { cid: string }) => {
    if (!d.cid || d.cid.length > 200) throw new Error("Invalid cid");
    return d;
  })
  .handler(async ({ data }) => {
    const e = transcodeEnv();
    if (!e.outputBucket) throw new Error("Transcode not configured");
    const { listObjects } = await import("./aws-s3.server");
    const prefix = `hls/${data.cid}/`;
    const keys = await listObjects(e.outputBucket, prefix);
    return { bucket: e.outputBucket, prefix, keys };
  });

export const simulateMediaConvertWebhook = createServerFn({ method: "POST" })
  .inputValidator((d: { cid: string; jobId: string; dryRun?: boolean }) => {
    if (!d.cid || d.cid.length > 200) throw new Error("Invalid cid");
    if (!d.jobId || d.jobId.length > 200) throw new Error("Invalid jobId");
    return d;
  })
  .handler(async ({ data }) => {
    // Dry-run path: still exercise the real webhook (signature + parsing)
    // via a self-fetch. Cheap enough — no pinning, no big payloads.
    if (data.dryRun) {
      const secret = process.env.MEDIACONVERT_WEBHOOK_SECRET;
      if (!secret) throw new Error("MEDIACONVERT_WEBHOOK_SECRET not set");
      const { createHmac } = await import("crypto");
      const event = {
        source: "aws.mediaconvert",
        "detail-type": "MediaConvert Job State Change",
        detail: {
          jobId: data.jobId,
          status: "COMPLETE",
          userMetadata: { videoId: data.cid },
        },
      };
      const body = JSON.stringify(event);
      const sig = createHmac("sha256", secret).update(body).digest("hex");
      const { getRequest } = await import("@tanstack/react-start/server");
      const origin = new URL(getRequest().url).origin;
      const url = `${origin}/api/public/hooks/mediaconvert?dryRun=1`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-signature": sig },
        body,
      });
      return { status: res.status, body: await res.text(), url };
    }

    // Full path: run the pin-to-IPFS work directly in this server fn instead
    // of self-fetching the webhook. Self-fetch doubles request time on
    // Cloudflare and was timing out for ~40 MB transfers.
    const e = transcodeEnv();
    if (!e.inputBucket || !e.outputBucket) throw new Error("AWS buckets not set");

    const { listObjects, getObjectBlob } = await import("./aws-s3.server");

    // 1. Pin the HLS bundle as a single directory. Do not fetch the original
    // input object here: the already-registered video CID is the canonical
    // original, and the app AWS user may intentionally only have write access
    // to the input bucket.
    const prefix = `hls/${data.cid}/`;
    const t0 = Date.now();
    console.log(`[transcode ${data.cid}] job ${data.jobId} complete — listing HLS outputs from s3://${e.outputBucket}/${prefix}`);
    const keys = await listObjects(e.outputBucket, prefix);
    if (keys.length === 0) throw new Error(`No outputs at s3://${e.outputBucket}/${prefix}`);
    const tList = Date.now() - t0;
    console.log(`[transcode ${data.cid}] transcode finished — ${keys.length} output objects (list took ${tList}ms), starting IPFS pin`);

    const t1 = Date.now();
    let pinned: { cid: string; size: number };
    const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
    const lambdaUrl = process.env.IPFS_LAMBDA_URL;
    const lambdaName = process.env.IPFS_LAMBDA_NAME;
    if (lambdaToken && (lambdaName || lambdaUrl)) {
      console.log(`[transcode ${data.cid}] pinning to self-hosted IPFS (ipfs.honest.money) via Lambda`);
      const { callPinLambda } = await import("./ipfs-lambda.functions");
      const json = await callPinLambda({ bucket: e.outputBucket, keys }, lambdaToken);
      if (!json.cid) throw new Error("Lambda /pin returned no cid");
      pinned = { cid: json.cid, size: json.totalBytes ?? 0 };
    } else {
      console.log(`[transcode ${data.cid}] pinning to Pinata (self-hosted Lambda not configured)`);
      const { pinDirectoryToIPFS } = await import("./pinata.server");
      const files = await mapWithConcurrency(keys, 8, async (key) => {
        const blob = await getObjectBlob(e.outputBucket!, key);
        return {
          path: key.slice(prefix.length),
          body: blob,
          contentType: blob.type || undefined,
        };
      });
      pinned = await pinDirectoryToIPFS(files, `hls-${data.cid}`);
    }
    const tFetch = Date.now() - t1;
    console.log(`[transcode ${data.cid}] IPFS pin complete in ${tFetch}ms → ${pinned.cid} (${pinned.size} bytes)`);

    // 3. Derive a rendition manifest (mirrors what the real webhook builds).
    const renditions = keys
      .filter((k) => k.endsWith(".m3u8") && !k.endsWith("/master.m3u8"))
      .map((k) => {
        const rel = k.slice(prefix.length);
        const m = rel.match(/(\d+)p/);
        return { height: m ? Number(m[1]) : null, playlist: rel };
      });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("videos")
      .select("video_wallet, owner_wallet, title, description, thumbnail_cid")
      .eq("cid", data.cid)
      .maybeSingle();

    let newMetaCid: string | null = null;
    let newMetaTx: string | null = null;
    if (row && row.video_wallet && row.owner_wallet) {
      const { recordMetadataAnchor } = await import("./chain-events.server");
      const anchored = await recordMetadataAnchor({
        videoCid: data.cid,
        videoWallet: row.video_wallet,
        uploaderWallet: row.owner_wallet,
        title: row.title ?? "",
        description: row.description ?? "",
        thumbnailCid: row.thumbnail_cid ?? null,
        hlsCid: pinned.cid,
        renditions,
      });
      if (anchored) {
        newMetaCid = anchored.metaCid;
        newMetaTx = anchored.stamp.real ? anchored.stamp.txid : null;
      }
    }

    const { error: updErr, count } = await supabaseAdmin
      .from("videos")
      .update({
        hls_cid: pinned.cid,
        renditions,
        transcode_status: "ready",
        transcode_completed_at: new Date().toISOString(),
        transcode_error: null,
        ...(newMetaCid ? { metadata_cid: newMetaCid } : {}),
        ...(newMetaTx ? { tx_hash: newMetaTx } : {}),
      }, { count: "exact" })
      .eq("cid", data.cid)
      .eq("transcode_job_id", data.jobId);
    if (updErr) throw updErr;

    return {
      status: 200,
      body: JSON.stringify({
        hlsCid: pinned.cid,
        metadataCid: newMetaCid,
        metadataTx: newMetaTx,
        keys: keys.length,
        rowsUpdated: count ?? 0,
        timings: { listMs: tList, pinMs: tFetch },
      }),
      url: `inline://${data.cid}`,
    };
  });

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}