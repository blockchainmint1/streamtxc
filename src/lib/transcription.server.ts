// Post-transcode transcription: take the MediaConvert audio-only output
// from S3, send it to Lovable AI gateway's OpenAI-compatible
// /audio/transcriptions endpoint and store the transcript text on the
// videos row (shown in the watch page's transcript panel).
//
// Runs for every finished transcode so every video gets closed
// captions. Idempotent: skips work if transcript_cid is already set.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getObjectBlob } from "./aws-s3.server";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
const TRANSCRIBE_MODEL = "openai/gpt-4o-mini-transcribe";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI transcription hard limit

export interface TranscribeResult {
  transcriptText: string;
  /** Timed caption file on IPFS. Null: the AI service returns text only, no timings. */
  transcriptCid: string | null;
  vttBytes: number;
}

/**
 * Transcribe the MediaConvert audio output for `cid`. No-op when the
 * video isn't a Zoom import or already has a transcript. Returns null
 * when skipped.
 */
export async function maybeTranscribeVideo(
  cid: string,
): Promise<TranscribeResult | null> {
  const { data: row, error } = await supabaseAdmin
    .from("videos")
    .select("cid, transcript_cid, transcript_text")
    .eq("cid", cid)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  if (row.transcript_cid) return null;
  if (row.transcript_text && !row.transcript_text.startsWith("[Transcript skipped")) return null;

  const key = await pickAudioKey(cid);
  if (!key) {
    console.warn(`[transcribe ${cid}] no audio output found at audio/${cid}/`);
    return null;
  }

  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET!;
  const blob = await getObjectBlob(outputBucket, key);
  if (blob.size === 0) {
    console.warn(`[transcribe ${cid}] audio object is empty`);
    return null;
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    console.warn(
      `[transcribe ${cid}] audio ${blob.size} bytes exceeds whisper-1 limit (${MAX_AUDIO_BYTES}); skipping`,
    );
    await supabaseAdmin
      .from("videos")
      .update({
        transcript_text:
          "[Transcript skipped: recording too long for inline transcription. Coming soon: chunked transcription for long videos.]",
      })
      .eq("cid", cid);
    return null;
  }

  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn(`[transcribe ${cid}] LOVABLE_API_KEY not set, skipping`);
    return null;
  }

  // The gateway's transcription endpoint returns plain text only (json/text
  // formats; no caption timings), so we store the transcript for the watch
  // page panel. Timed captions (.vtt) need a timing-capable service.
  const form = new FormData();
  form.append("file", blob, "audio.mp4");
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");

  const res = await fetch(`${GATEWAY_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { "Lovable-API-Key": apiKey },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new Error(`Transcription rate-limited (429): ${text.slice(0, 200)}`);
    }
    if (res.status === 402) {
      throw new Error(`Transcription credits exhausted (402): ${text.slice(0, 200)}`);
    }
    throw new Error(`Transcription failed [${res.status}]: ${text.slice(0, 400)}`);
  }
  const body = (await res.json().catch(() => null)) as { text?: string } | null;
  const plain = (body?.text ?? "").replace(/\s+/g, " ").trim();
  if (!plain) {
    console.warn(`[transcribe ${cid}] empty transcript`);
    return null;
  }

  await supabaseAdmin
    .from("videos")
    .update({ transcript_text: plain })
    .eq("cid", cid);

  return {
    transcriptText: plain,
    transcriptCid: null,
    vttBytes: 0,
  };
}

async function pickAudioKey(cid: string): Promise<string | null> {
  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
  if (!outputBucket) return null;
  const { listObjects } = await import("./aws-s3.server");
  const keys = await listObjects(outputBucket, `audio/${cid}/`);
  if (!keys.length) return null;
  // Prefer the MediaConvert output we configured (NameModifier "source").
  return (
    keys.find((k) => /source\.(mp4|m4a|mp3)$/i.test(k)) ??
    keys.find((k) => /\.(mp4|m4a|mp3)$/i.test(k)) ??
    keys[0]
  );
}
