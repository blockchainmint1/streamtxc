// Post-transcode transcription: take the MediaConvert audio-only output
// from S3, send it to Lovable AI gateway's OpenAI-compatible
// /audio/transcriptions endpoint, pin the resulting WebVTT to IPFS, and
// stamp the transcript CID on the videos row.
//
// Runs for every finished transcode so every video gets closed
// captions. Idempotent: skips work if transcript_cid is already set.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getObjectBlob } from "./aws-s3.server";
import { pinFileToIPFS } from "./pinata.server";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";
const TRANSCRIBE_MODEL = "openai/gpt-4o-mini-transcribe";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI transcription hard limit

export interface TranscribeResult {
  transcriptText: string;
  transcriptCid: string;
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
    .select("cid, transcript_cid")
    .eq("cid", cid)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  if (row.transcript_cid) return null;

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

  // OpenAI-compatible multipart form. response_format=vtt returns WebVTT
  // (already cue-timed) which we both pin and parse into plain text for
  // the watch page transcript panel.
  const form = new FormData();
  form.append("file", blob, "audio.mp4");
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "vtt");

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
  const vtt = await res.text();
  if (!vtt.trim()) {
    console.warn(`[transcribe ${cid}] empty transcript`);
    return null;
  }

  // Pin the .vtt to IPFS so the on-chain metadata can point at it.
  const vttBlob = new Blob([vtt], { type: "text/vtt" });
  const pin = await pinFileToIPFS(vttBlob, `${cid}.transcript.vtt`);

  const plain = vttToPlainText(vtt);

  await supabaseAdmin
    .from("videos")
    .update({
      transcript_cid: pin.cid,
      transcript_text: plain,
    })
    .eq("cid", cid);

  return {
    transcriptText: plain,
    transcriptCid: pin.cid,
    vttBytes: vtt.length,
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

/**
 * WebVTT → plain text. Drops cue timings and just concatenates text.
 * Good enough for a transcript panel; full VTT remains the IPFS source
 * of truth.
 */
function vttToPlainText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (/^\d+$/.test(line)) continue; // cue number
    if (/-->/.test(line)) continue; // timestamps
    if (/^NOTE\b/.test(line)) continue;
    out.push(line);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}