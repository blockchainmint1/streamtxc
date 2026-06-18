// Shared post-pin "finalize" logic used by both the MediaConvert webhook
// (sync path: pin happens inside the webhook) and the IPFS Lambda async
// callback webhook (pin happens in the Lambda, callback hits us with the
// resulting CID). Keeps the chain-anchor + DB-update logic in exactly
// one place.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface FinalizeInput {
  cid: string;
  jobId: string;
  hlsCid: string;
  /** Derived from listing the HLS output bucket prefix. */
  renditions: Array<{ height: number | null; playlist: string }>;
}

export interface FinalizeResult {
  rowsUpdated: number;
  metadataCid: string | null;
  metadataTx: string | null;
}

export async function finalizeHlsPin(input: FinalizeInput): Promise<FinalizeResult> {
  const { data: row } = await supabaseAdmin
    .from("videos")
    .select("video_wallet, owner_wallet, title, description, thumbnail_cid")
    .eq("cid", input.cid)
    .maybeSingle();

  let metadataCid: string | null = null;
  let metadataTx: string | null = null;
  if (row && row.video_wallet && row.owner_wallet) {
    const { recordMetadataAnchor } = await import("./chain-events.server");
    const anchored = await recordMetadataAnchor({
      videoCid: input.cid,
      videoWallet: row.video_wallet,
      uploaderWallet: row.owner_wallet,
      title: row.title ?? "",
      description: row.description ?? "",
      thumbnailCid: row.thumbnail_cid ?? null,
      hlsCid: input.hlsCid,
      renditions: input.renditions,
    });
    if (anchored) {
      metadataCid = anchored.metaCid;
      metadataTx = anchored.stamp.real ? anchored.stamp.txid : null;
    }
  }

  const { count } = await supabaseAdmin
    .from("videos")
    .update({
      hls_cid: input.hlsCid,
      renditions: input.renditions,
      transcode_status: "ready",
      transcode_completed_at: new Date().toISOString(),
      transcode_error: null,
      ...(metadataCid ? { metadata_cid: metadataCid } : {}),
      ...(metadataTx ? { tx_hash: metadataTx } : {}),
    }, { count: "exact" })
    .eq("cid", input.cid)
    .eq("transcode_job_id", input.jobId);

  return { rowsUpdated: count ?? 0, metadataCid, metadataTx };
}

/** Derive renditions list from S3 keys (e.g. `hls/<cid>/720p.m3u8`). */
export function renditionsFromKeys(
  keys: string[],
  prefix: string,
): Array<{ height: number | null; playlist: string }> {
  return keys
    .filter((k) => k.endsWith(".m3u8") && !k.endsWith("/master.m3u8"))
    .map((k) => {
      const rel = k.slice(prefix.length);
      const m = rel.match(/(\d+)p/);
      return { height: m ? Number(m[1]) : null, playlist: rel };
    });
}

/**
 * Re-run the pin + chain-anchor pipeline for a single video whose
 * MediaConvert outputs are already in S3 but never got pinned. Shared by:
 *   - POST /api/public/admin/finalize-hls  (manual one-off)
 *   - payment-watcher cron (auto-retry stuck transcode_status='pinning')
 *
 * Throws on unrecoverable error. Returns { alreadyFinalized: true } if the
 * row already has hls_cid (idempotent — safe to call repeatedly).
 */
export async function retryFinalizePinFromS3(cid: string): Promise<{
  alreadyFinalized?: boolean;
  hlsCid?: string;
  keys?: number;
  rowsUpdated?: number;
  metadataCid?: string | null;
  metadataTx?: string | null;
}> {
  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
  if (!outputBucket) throw new Error("Transcode not configured");

  const { data: v, error } = await supabaseAdmin
    .from("videos")
    .select("cid, transcode_job_id, hls_cid")
    .eq("cid", cid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!v) throw new Error("Video not found");
  if (v.hls_cid) return { alreadyFinalized: true, hlsCid: v.hls_cid };
  const jobId = v.transcode_job_id;
  if (!jobId) throw new Error("No transcode job recorded");

  const { listObjects, getObjectBlob } = await import("./aws-s3.server");
  const prefix = `hls/${cid}/`;
  const keys = await listObjects(outputBucket, prefix);
  if (keys.length === 0) {
    throw new Error(`No HLS outputs at s3://${outputBucket}/${prefix}`);
  }

  let pinned: { cid: string; size: number };
  const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
  const lambdaUrl = process.env.IPFS_LAMBDA_URL;
  const lambdaName = process.env.IPFS_LAMBDA_NAME;
  if (lambdaToken && (lambdaName || lambdaUrl)) {
    const { callPinLambda } = await import("./ipfs-lambda.functions");
    const json = await callPinLambda({ bucket: outputBucket, keys }, lambdaToken);
    if (!json.cid) throw new Error("Lambda /pin returned no cid");
    pinned = { cid: json.cid, size: json.totalBytes ?? 0 };
  } else {
    const { pinDirectoryToIPFS } = await import("./pinata.server");
    const files: Array<{ path: string; body: Blob; contentType?: string }> = [];
    for (const key of keys) {
      const blob = await getObjectBlob(outputBucket, key);
      files.push({
        path: key.slice(prefix.length),
        body: blob,
        contentType: blob.type || undefined,
      });
    }
    pinned = await pinDirectoryToIPFS(files, `hls-${cid}`);
  }

  const renditions = renditionsFromKeys(keys, prefix);
  const finalized = await finalizeHlsPin({
    cid,
    jobId,
    hlsCid: pinned.cid,
    renditions,
  });

  return {
    hlsCid: pinned.cid,
    keys: keys.length,
    rowsUpdated: finalized.rowsUpdated,
    metadataCid: finalized.metadataCid,
    metadataTx: finalized.metadataTx,
  };
}