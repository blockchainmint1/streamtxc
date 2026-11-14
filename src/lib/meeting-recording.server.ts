// Meeting recording + AI notes (server only).
//
// Start: (notes) Amazon live transcription → media capture pipeline (5-second
// pieces into the private recordings bucket) → concatenation pipeline created
// up front (AWS joins the pieces when capture stops).
// Stop: stop transcription + capture → row goes to "processing".
// Tick (every 2 min): finished files found → video ready, transcript parsed,
// AI notes written. Publish: copy to the transcode bucket → MediaConvert HLS →
// IPFS pin (Lambda) → ipfs-pin-complete inserts the channel video.

import { parseChimeTranscript, transcriptToText, RECORDING_KEEP_DAYS } from "./meeting-rules";

/** Processing longer than this after the meeting ended means AWS gave up. */
const PROCESSING_TIMEOUT_MS = 4 * 3600_000;

export type RecordingRow = {
  id: string;
  room_id: string;
  owner_wallet: string;
  title: string;
  chime_meeting_id: string;
  record_video: boolean;
  take_notes: boolean;
  capture_pipeline_id: string | null;
  capture_pipeline_arn: string | null;
  concat_pipeline_id: string | null;
  transcription_started: boolean;
  status: "recording" | "processing" | "ready" | "failed";
  started_at: string;
  ended_at: string | null;
  video_key: string | null;
  video_bytes: number | null;
  transcript: unknown;
  transcript_text: string | null;
  notes_status: "none" | "pending" | "ready" | "failed";
  summary: string | null;
  key_points: unknown;
  decisions: unknown;
  action_items: unknown;
  publish_status: "private" | "transcoding" | "pinning" | "published" | "failed";
  publish_job_id: string | null;
  published_cid: string | null;
  error: string | null;
  deleted_at: string | null;
  created_at: string;
};

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

export async function activeRecording(roomId: string): Promise<RecordingRow | null> {
  const sb = await db();
  const { data } = await sb
    .from("meeting_recordings")
    .select("*")
    .eq("room_id", roomId)
    .eq("status", "recording")
    .maybeSingle();
  return (data as RecordingRow) ?? null;
}

function friendlyAws(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/permission is missing/i.test(msg)) {
    return "Recording isn't switched on in AWS yet — the one-time AWS setup still needs to be run.";
  }
  return "AWS couldn't start recording. Try again in a minute.";
}

/** Starts recording and/or notes on the room's open meeting. Returns the active recording. */
export async function startRecording(
  room: { id: string; owner_wallet: string; title: string; chime_meeting_id: string | null },
  opts: { video: boolean; notes: boolean },
): Promise<RecordingRow> {
  if (!opts.video && !opts.notes) throw new Error("Pick recording, notes, or both.");
  if (!room.chime_meeting_id) throw new Error("Start the meeting first.");
  const existing = await activeRecording(room.id);
  if (existing) return existing;

  const chime = await import("./aws-chime.server");
  const meeting = await chime.getMeeting(room.chime_meeting_id);
  if (!meeting?.MeetingArn) throw new Error("The meeting has ended — join again to restart it.");

  const id = crypto.randomUUID();
  let transcribing = false;
  let capture: { pipelineId: string; pipelineArn: string } | null = null;
  let concatId: string | null = null;
  try {
    if (opts.notes) {
      await chime.startMeetingTranscription(room.chime_meeting_id);
      transcribing = true;
    }
    capture = await chime.createCapturePipeline({
      meetingArn: meeting.MeetingArn,
      prefix: `capture/${id}`,
      video: opts.video,
      token: `${id}-capture`,
    });
    ({ pipelineId: concatId } = await chime.createConcatPipeline({
      capturePipelineArn: capture.pipelineArn,
      prefix: `final/${id}`,
      video: opts.video,
      notes: opts.notes,
      token: `${id}-concat`,
    }));
  } catch (err) {
    console.error("[meet-rec] start failed", err);
    if (capture) await chime.stopMediaPipeline(capture.pipelineId).catch(() => {});
    if (transcribing) await chime.stopMeetingTranscription(room.chime_meeting_id).catch(() => {});
    throw new Error(friendlyAws(err));
  }

  const sb = await db();
  const { data, error } = await sb
    .from("meeting_recordings")
    .insert({
      id,
      room_id: room.id,
      owner_wallet: room.owner_wallet,
      title: room.title,
      chime_meeting_id: room.chime_meeting_id,
      record_video: opts.video,
      take_notes: opts.notes,
      capture_pipeline_id: capture.pipelineId,
      capture_pipeline_arn: capture.pipelineArn,
      concat_pipeline_id: concatId,
      transcription_started: transcribing,
      status: "recording",
    })
    .select("*")
    .single();
  if (error) {
    // Someone else started one a moment ago — keep theirs, undo ours.
    await chime.stopMediaPipeline(capture.pipelineId).catch(() => {});
    if (concatId) await chime.stopMediaPipeline(concatId).catch(() => {});
    const other = await activeRecording(room.id);
    if (other) return other;
    if (transcribing) await chime.stopMeetingTranscription(room.chime_meeting_id).catch(() => {});
    throw new Error("Couldn't save the recording. Try again.");
  }
  return data as RecordingRow;
}

/** Stops capture (and transcription); AWS then joins the pieces into finished files. */
export async function stopRecording(rec: RecordingRow): Promise<void> {
  if (rec.status !== "recording") return;
  const chime = await import("./aws-chime.server");
  if (rec.transcription_started) await chime.stopMeetingTranscription(rec.chime_meeting_id).catch(() => {});
  if (rec.capture_pipeline_id) await chime.stopMediaPipeline(rec.capture_pipeline_id).catch(() => {});
  const sb = await db();
  await sb
    .from("meeting_recordings")
    .update({
      status: "processing",
      ended_at: new Date().toISOString(),
      notes_status: rec.take_notes ? "pending" : "none",
      updated_at: new Date().toISOString(),
    })
    .eq("id", rec.id)
    .eq("status", "recording");
}

export async function stopRoomRecordings(roomId: string): Promise<void> {
  const rec = await activeRecording(roomId);
  if (rec) await stopRecording(rec);
}

/** The room's settings say record/notes every time → start once the meeting is open. */
export async function maybeAutoStart(room: {
  id: string; owner_wallet: string; title: string; chime_meeting_id: string | null;
  auto_record?: boolean; auto_notes?: boolean;
}): Promise<void> {
  if (!room.auto_record && !room.auto_notes) return;
  try {
    await startRecording(room, { video: !!room.auto_record, notes: !!room.auto_notes });
  } catch (err) {
    console.warn(`[meet-rec ${room.id}] auto-start failed`, err);
  }
}

// ---------- Processing (finished files → video + notes) ----------

async function finishedFiles(rec: RecordingRow) {
  const { recordingsBucket } = await import("./aws-chime.server");
  const { listObjectsWithMeta } = await import("./aws-s3.server");
  const objs = await listObjectsWithMeta(recordingsBucket(), `final/${rec.id}/`);
  const video = objs.find((o) => /\/composited-video\/[^/]+\.mp4$/i.test(o.key) && o.size > 0) ?? null;
  const transcript = objs.find((o) => /\/transcription-messages\/[^/]+\.txt$/i.test(o.key)) ?? null;
  return { video, transcript };
}

async function writeNotes(rec: RecordingRow, transcriptKey: string | null): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  let text = rec.transcript_text;
  if (text === null) {
    let lines: ReturnType<typeof parseChimeTranscript> = [];
    if (transcriptKey) {
      const { recordingsBucket } = await import("./aws-chime.server");
      const { getObjectBlob } = await import("./aws-s3.server");
      const raw = await (await getObjectBlob(recordingsBucket(), transcriptKey)).text();
      lines = parseChimeTranscript(raw, Date.parse(rec.started_at));
    }
    text = transcriptToText(lines);
    patch.transcript = lines;
    patch.transcript_text = text;
  }
  if (!text.trim()) {
    return { ...patch, notes_status: "ready", summary: "No speech was picked up during this recording.", key_points: [], decisions: [], action_items: [] };
  }
  const { writeMeetingNotes } = await import("./meeting-notes-ai.server");
  try {
    const notes = await writeMeetingNotes({ title: rec.title, transcriptText: text });
    return {
      ...patch,
      notes_status: "ready",
      summary: notes.summary,
      key_points: notes.key_points,
      decisions: notes.decisions,
      action_items: notes.action_items,
      error: null,
    };
  } catch (err) {
    console.error(`[meet-rec ${rec.id}] notes failed`, err);
    return { ...patch, notes_status: "failed", error: err instanceof Error ? err.message : "AI notes failed." };
  }
}

/** Checks one recording that is processing; finishes it when AWS's files are ready. */
export async function processRecording(rec: RecordingRow): Promise<string> {
  const sb = await db();
  const chime = await import("./aws-chime.server");
  const concatStatus = rec.concat_pipeline_id ? await chime.getMediaPipelineStatus(rec.concat_pipeline_id).catch(() => "unknown") : null;
  const files = await finishedFiles(rec);
  const haveVideo = !rec.record_video || !!files.video;
  const haveTranscript = !rec.take_notes || !!files.transcript;
  const endedMs = Date.parse(rec.ended_at ?? rec.started_at);
  const timedOut = Date.now() - endedMs > PROCESSING_TIMEOUT_MS;
  // AWS finished joining (or gave up) → use whatever files exist.
  const done = concatStatus === "Stopped" || concatStatus === "Failed" || concatStatus === null || timedOut;
  if ((!haveVideo || !haveTranscript) && !done) return "waiting";
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (files.video) {
    patch.video_key = files.video.key;
    patch.video_bytes = files.video.size;
  }
  if (rec.take_notes) Object.assign(patch, await writeNotes(rec, files.transcript?.key ?? null));
  const nothing = (rec.record_video && !files.video) && (!rec.take_notes || !files.transcript);
  patch.status = nothing ? "failed" : "ready";
  if (nothing) patch.error = "AWS didn't produce the recording files.";
  else if (rec.record_video && !files.video) patch.error = "The video didn't come through, but the notes did.";
  await sb.from("meeting_recordings").update(patch).eq("id", rec.id).eq("status", "processing");
  return String(patch.status);
}

/** Host clicked "Try notes again" after an AI problem. */
export async function retryNotes(rec: RecordingRow): Promise<void> {
  if (rec.status !== "ready" || !rec.take_notes || rec.notes_status === "ready") return;
  const files = rec.transcript_text === null ? await finishedFiles(rec) : { transcript: null };
  const patch = await writeNotes(rec, files.transcript?.key ?? null);
  const sb = await db();
  await sb.from("meeting_recordings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", rec.id);
}

// ---------- Publish to the host's channel ----------

export async function startPublish(rec: RecordingRow): Promise<void> {
  if (rec.publish_status !== "private" && rec.publish_status !== "failed") return;
  if (!rec.video_key) throw new Error("This recording has no video to publish.");
  const inputBucket = process.env.AWS_S3_INPUT_BUCKET;
  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
  if (!inputBucket || !outputBucket) throw new Error("Video publishing isn't configured.");
  const { recordingsBucket } = await import("./aws-chime.server");
  const { copyObject } = await import("./aws-s3.server");
  const inputKey = `inputs/meet-${rec.id}.mp4`;
  await copyObject({ srcBucket: recordingsBucket(), srcKey: rec.video_key, dstBucket: inputBucket, dstKey: inputKey });
  const { startHlsTranscodeFromInputs } = await import("./aws-mediaconvert.server");
  const { jobId } = await startHlsTranscodeFromInputs({
    inputUris: [`s3://${inputBucket}/${inputKey}`],
    outputPrefix: `s3://${outputBucket}/hls/meet-${rec.id}/`,
    videoId: `meet:${rec.id}`,
  });
  const sb = await db();
  await sb
    .from("meeting_recordings")
    .update({ publish_status: "transcoding", publish_job_id: jobId, error: null, updated_at: new Date().toISOString() })
    .eq("id", rec.id);
}

async function advancePublish(rec: RecordingRow, origin: string): Promise<string> {
  const sb = await db();
  if (!rec.publish_job_id) return "no-job";
  if (rec.publish_status === "pinning") {
    // The Lambda calls back; only re-pin if it has been silent for a long time.
    if (Date.now() - Date.parse((rec as any).updated_at ?? rec.created_at) < 20 * 60_000) return "pin-in-flight";
  } else {
    const { describeJob } = await import("./aws-mediaconvert.server");
    const job = (await describeJob(rec.publish_job_id)).job;
    const status = job?.status ?? "UNKNOWN";
    if (status === "ERROR" || status === "CANCELED") {
      await sb.from("meeting_recordings").update({ publish_status: "failed", error: "The video conversion failed." }).eq("id", rec.id);
      return "failed";
    }
    if (status !== "COMPLETE") return "transcoding";
  }
  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET!;
  const prefix = `hls/meet-${rec.id}/`;
  const { listObjects } = await import("./aws-s3.server");
  const keys = await listObjects(outputBucket, prefix);
  if (!keys.length) {
    await sb.from("meeting_recordings").update({ publish_status: "failed", error: "The converted video files are missing." }).eq("id", rec.id);
    return "failed";
  }
  const fnName = process.env.IPFS_LAMBDA_NAME;
  const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
  const callbackSecret = process.env.MEDIACONVERT_WEBHOOK_SECRET;
  if (!fnName || !lambdaToken || !callbackSecret) throw new Error("IPFS pinning isn't configured.");
  const { invokeLambdaAsync } = await import("./aws-lambda.server");
  await invokeLambdaAsync(fnName, {
    routeKey: "POST /pin",
    headers: { authorization: `Bearer ${lambdaToken}` },
    body: JSON.stringify({
      bucket: outputBucket,
      keys,
      callbackUrl: `${origin}/api/public/hooks/ipfs-pin-complete`,
      callbackSecret,
      callbackMeta: { meetingRecordingId: rec.id, jobId: rec.publish_job_id, prefix },
    }),
  });
  await sb.from("meeting_recordings").update({ publish_status: "pinning", updated_at: new Date().toISOString() }).eq("id", rec.id);
  return "pin-started";
}

/** Runs every couple of minutes from cron. */
export async function runMeetingRecordingTick(origin: string) {
  const sb = await db();
  const results: Array<Record<string, unknown>> = [];

  const { data: processing } = await sb.from("meeting_recordings").select("*").eq("status", "processing").limit(5);
  for (const rec of (processing ?? []) as RecordingRow[]) {
    try {
      results.push({ id: rec.id, action: await processRecording(rec) });
    } catch (err) {
      results.push({ id: rec.id, action: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const { data: publishing } = await sb
    .from("meeting_recordings")
    .select("*")
    .in("publish_status", ["transcoding", "pinning"])
    .limit(5);
  for (const rec of (publishing ?? []) as RecordingRow[]) {
    try {
      results.push({ id: rec.id, publish: await advancePublish(rec, origin) });
    } catch (err) {
      results.push({ id: rec.id, publish: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Safety net: a recording whose meeting AWS already closed is stopped.
  const { data: recording } = await sb.from("meeting_recordings").select("*").eq("status", "recording").limit(20);
  if (recording?.length) {
    const chime = await import("./aws-chime.server");
    for (const rec of recording as RecordingRow[]) {
      const live = await chime.getMeeting(rec.chime_meeting_id).catch(() => "unknown");
      if (!live) {
        await stopRecording(rec);
        results.push({ id: rec.id, action: "stopped_meeting_gone" });
      }
    }
  }
  return { results };
}

/** Is the private video file still kept (AWS deletes it after RECORDING_KEEP_DAYS)? */
export function videoStillKept(rec: Pick<RecordingRow, "started_at">): boolean {
  return Date.now() - Date.parse(rec.started_at) < RECORDING_KEEP_DAYS * 86400_000;
}
