// Backfill closed captions for videos transcoded before the audio-only
// output group existed. For each video without transcript_cid:
//
//   1. If s3://output/audio/<cid>/source.mp4 already exists, just run
//      the transcription pipeline against it.
//   2. Else, ensure s3://input/inputs/<cid> exists (fetch from the
//      IPFS gateway if missing, single-PUT only — capped at 200 MB to
//      keep the Worker memory bounded) and kick a MediaConvert
//      audio-only job. The webhook finishes the job by calling
//      maybeTranscribeVideo() once the audio file lands.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { headObject, s3PutObject } from "./aws-s3.server";
import { startAudioOnlyTranscode } from "./aws-mediaconvert.server";
import { maybeTranscribeVideo } from "./transcription.server";
import { gatewayUrl } from "./ipfs.server";

const SINGLE_PUT_MAX_BYTES = 200 * 1024 * 1024;

export type BackfillTranscriptResult = {
  cid: string;
  action:
    | "already_transcribed"
    | "transcribed_from_existing_audio"
    | "audio_job_queued"
    | "skipped_no_input"
    | "skipped_too_large"
    | "failed";
  jobId?: string;
  transcriptCid?: string;
  bytes?: number;
  error?: string;
};

export async function backfillOneTranscript(
  cid: string,
): Promise<BackfillTranscriptResult> {
  const inputBucket = process.env.AWS_S3_INPUT_BUCKET;
  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
  if (!inputBucket || !outputBucket) {
    throw new Error("AWS_S3_INPUT_BUCKET / OUTPUT_BUCKET not configured");
  }

  const { data: row, error } = await supabaseAdmin
    .from("videos")
    .select("cid, transcript_cid, hls_cid, size_bytes")
    .eq("cid", cid)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error(`Video not found: ${cid}`);
  if (row.transcript_cid) return { cid, action: "already_transcribed" };

  // Fast path: audio was already produced by an earlier transcode.
  const audioKey = `audio/${cid}/source.mp4`;
  const audioHead = await headObject(outputBucket, audioKey).catch(() => null);
  if (audioHead && audioHead.size > 0) {
    const t = await maybeTranscribeVideo(cid);
    return {
      cid,
      action: "transcribed_from_existing_audio",
      transcriptCid: t?.transcriptCid,
      bytes: t?.vttBytes,
    };
  }

  // Otherwise: make sure inputs/<cid> exists, then kick an audio-only job.
  const inputKey = `inputs/${cid}`;
  let inputHead = await headObject(inputBucket, inputKey).catch(() => null);
  if (!inputHead || inputHead.size === 0) {
    // Try fetching the origin from IPFS.
    const origin = withGatewayKey(gatewayUrl(cid));
    const head = await fetch(origin, { method: "HEAD" });
    if (!head.ok) return { cid, action: "skipped_no_input" };
    const size = Number(head.headers.get("content-length") ?? 0);
    const contentType = head.headers.get("content-type") || "video/mp4";
    if (!size || size > SINGLE_PUT_MAX_BYTES) {
      return { cid, action: "skipped_too_large" };
    }
    const res = await fetch(origin);
    if (!res.ok) return { cid, action: "skipped_no_input" };
    const blob = await res.blob();
    await s3PutObject({ bucket: inputBucket, key: inputKey, body: blob, contentType });
    inputHead = { size: blob.size, contentType, etag: null };
  }

  const { jobId } = await startAudioOnlyTranscode({
    inputUri: `s3://${inputBucket}/${inputKey}`,
    outputPrefix: `s3://${outputBucket}/hls/${cid}/`,
    videoId: cid,
  });
  return { cid, action: "audio_job_queued", jobId };
}

/** Pick videos with an HLS bundle but no transcript. Most-viewed first. */
export async function pickTranscriptCandidates(limit: number) {
  const { data, error } = await supabaseAdmin
    .from("videos")
    .select("cid, view_count")
    .not("hls_cid", "is", null)
    .is("transcript_cid", null)
    .order("view_count", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}