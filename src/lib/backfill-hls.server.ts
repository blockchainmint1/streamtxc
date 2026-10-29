// Backfill helper: take an old video that only has an origin `cid` (pinned to
// IPFS, never transcoded) and run it through the modern HLS pipeline.
//
// Steps:
//   1. Fetch the original bytes from our IPFS gateway (gatewayUrl()).
//   2. Upload to s3://AWS_S3_INPUT_BUCKET/inputs/{cid}
//      - single PUT for <= 80 MB
//      - multipart with 16 MB Range chunks for larger files (max we've
//        seen on-disk is ~1 GB)
//   3. Call startHlsTranscode → set transcode_status='processing'.
//
// After that the existing MediaConvert webhook + finalize-hls path takes over
// (pins HLS bundle, stamps metadata on chain, flips row to 'ready').

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  s3PutObject,
  createMultipartUpload,
  signMultipartPartUrl,
  completeMultipartUpload,
  abortMultipartUpload,
} from "./aws-s3.server";
import { startHlsTranscode } from "./aws-mediaconvert.server";
import { gatewayUrl, withGatewayKey } from "./ipfs.server";

// Multipart cutoff. Keep single-PUT path memory-bounded; anything larger goes
// through 16 MB ranged chunks so the Worker never holds the full file in RAM.
const SINGLE_PUT_MAX_BYTES = 80 * 1024 * 1024;
const PART_SIZE_BYTES = 16 * 1024 * 1024;
// Hard ceiling so a runaway 10 GB upload can't blow the cron budget. Anything
// bigger gets marked 'failed' with a clear error and a human can revisit.
const ABSOLUTE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export type BackfillResult = {
  cid: string;
  bytes: number;
  mode: "single" | "multipart";
  parts?: number;
  jobId: string;
};

export async function backfillOneHls(cid: string): Promise<BackfillResult> {
  const inputBucket = process.env.AWS_S3_INPUT_BUCKET;
  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
  if (!inputBucket || !outputBucket) {
    throw new Error("AWS_S3_INPUT_BUCKET / OUTPUT_BUCKET not configured");
  }

  // Guard: row exists, has origin cid, not already transcoded/in-flight.
  const { data: row, error: rErr } = await supabaseAdmin
    .from("videos")
    .select("cid, hls_cid, transcode_status, size_bytes")
    .eq("cid", cid)
    .maybeSingle();
  if (rErr) throw rErr;
  if (!row) throw new Error(`Video not found: ${cid}`);
  if (row.hls_cid) {
    return { cid, bytes: 0, mode: "single", jobId: "already_has_hls" };
  }
  if (
    row.transcode_status === "processing" ||
    row.transcode_status === "queued" ||
    row.transcode_status === "pinning"
  ) {
    return { cid, bytes: 0, mode: "single", jobId: `in_flight:${row.transcode_status}` };
  }

  const origin = withGatewayKey(gatewayUrl(cid));
  const key = `inputs/${cid}`;

  // HEAD first to size-route and to fail fast if gateway can't serve it.
  const head = await fetch(origin, { method: "HEAD" });
  if (!head.ok) {
    throw new Error(`Gateway HEAD ${origin} -> ${head.status}`);
  }
  const lenHeader = head.headers.get("content-length");
  const contentType = head.headers.get("content-type") || "video/mp4";
  const size = lenHeader ? Number(lenHeader) : Number(row.size_bytes ?? 0);
  if (!size || !Number.isFinite(size)) {
    throw new Error(`Unknown content-length for ${cid}`);
  }
  if (size > ABSOLUTE_MAX_BYTES) {
    throw new Error(`Origin too large for backfill (${size} bytes)`);
  }

  // ---- Pull origin → push to S3 -------------------------------------------
  let mode: "single" | "multipart";
  let parts = 0;

  if (size <= SINGLE_PUT_MAX_BYTES) {
    mode = "single";
    const res = await fetch(origin);
    if (!res.ok) throw new Error(`Gateway GET ${origin} -> ${res.status}`);
    const blob = await res.blob();
    await s3PutObject({ bucket: inputBucket, key, body: blob, contentType });
  } else {
    mode = "multipart";
    const { uploadId } = await createMultipartUpload({
      bucket: inputBucket,
      key,
      contentType,
    });
    const partEtags: { partNumber: number; etag: string }[] = [];
    try {
      let partNumber = 1;
      for (let start = 0; start < size; start += PART_SIZE_BYTES) {
        const end = Math.min(start + PART_SIZE_BYTES - 1, size - 1);
        const rangeRes = await fetch(origin, {
          headers: { Range: `bytes=${start}-${end}` },
        });
        if (!rangeRes.ok && rangeRes.status !== 206) {
          throw new Error(
            `Gateway Range ${start}-${end} -> ${rangeRes.status}`,
          );
        }
        const bytes = new Uint8Array(await rangeRes.arrayBuffer());
        if (bytes.byteLength === 0) {
          throw new Error(`Empty range ${start}-${end}`);
        }
        const url = await signMultipartPartUrl({
          bucket: inputBucket,
          key,
          uploadId,
          partNumber,
          expiresSeconds: 3600,
        });
        const putRes = await fetch(url, { method: "PUT", body: bytes });
        if (!putRes.ok) {
          throw new Error(
            `S3 part ${partNumber} PUT failed [${putRes.status}]: ${await putRes.text().catch(() => "")}`,
          );
        }
        const etag = putRes.headers.get("etag");
        if (!etag) throw new Error(`S3 part ${partNumber} returned no ETag`);
        partEtags.push({ partNumber, etag });
        partNumber++;
      }
      await completeMultipartUpload({
        bucket: inputBucket,
        key,
        uploadId,
        parts: partEtags,
      });
      parts = partEtags.length;
    } catch (err) {
      await abortMultipartUpload({ bucket: inputBucket, key, uploadId }).catch(
        () => {},
      );
      throw err;
    }
  }

  // ---- Kick MediaConvert --------------------------------------------------
  const { jobId } = await startHlsTranscode({
    inputUri: `s3://${inputBucket}/${key}`,
    outputPrefix: `s3://${outputBucket}/hls/${cid}/`,
    videoId: cid,
  });

  await supabaseAdmin
    .from("videos")
    .update({
      transcode_status: "processing",
      transcode_job_id: jobId,
      transcode_started_at: new Date().toISOString(),
      transcode_error: null,
    })
    .eq("cid", cid);

  return { cid, bytes: size, mode, parts, jobId };
}

/**
 * Pick up to `limit` old videos that have an origin cid but no hls bundle and
 * are not already in flight. Ordered by view_count DESC so the most-watched
 * legacy uploads get the HLS treatment first.
 */
export async function pickBackfillCandidates(limit: number) {
  const { data, error } = await supabaseAdmin
    .from("videos")
    .select("cid, view_count, size_bytes")
    .not("cid", "is", null)
    .is("hls_cid", null)
    .like("mime_type", "video/%")
    .gte("size_bytes", 100000)
    .or("transcode_status.is.null,transcode_status.eq.failed")
    .order("view_count", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}