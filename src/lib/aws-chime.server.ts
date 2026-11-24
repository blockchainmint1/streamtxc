// Amazon Chime SDK (meetings + live connector) via aws4fetch — no AWS SDK, Worker-safe.

import { AwsClient } from "aws4fetch";

function region() {
  return process.env.CHIME_REGION ?? process.env.MEDIALIVE_REGION ?? process.env.AWS_REGION ?? "us-east-1";
}

function client() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("AWS not configured");
  return new AwsClient({ accessKeyId, secretAccessKey, region: region(), service: "chime" });
}

export class ChimeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call(host: "meetings" | "pipelines", method: string, path: string, body?: unknown) {
  const base =
    host === "meetings"
      ? `https://meetings-chime.${region()}.amazonaws.com`
      : `https://media-pipelines-chime.${region()}.amazonaws.com`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await client().fetch(base + path, init);
  const text = await res.text();
  if (!res.ok) {
    console.error(`[chime] ${method} ${path} [${res.status}]`, text.slice(0, 400));
    if (res.status === 403 && /not authorized/i.test(text)) {
      throw new ChimeError(403, "AWS meeting permission is missing for this site.");
    }
    throw new ChimeError(res.status, `AWS meeting request failed (${res.status}).`);
  }
  return text ? JSON.parse(text) : {};
}

export interface ChimeMeeting {
  MeetingId: string;
  MeetingArn?: string;
  ExternalMeetingId?: string;
  MediaRegion: string;
  MediaPlacement: Record<string, string>;
}

export async function createMeeting(args: { token: string; externalId: string }): Promise<ChimeMeeting> {
  const raw = await call("meetings", "POST", "/meetings", {
    ClientRequestToken: args.token,
    ExternalMeetingId: args.externalId,
    MediaRegion: region(),
  });
  return raw.Meeting as ChimeMeeting;
}

/** Returns null when the meeting has ended (Chime ends rooms ~5 min after everyone leaves). */
export async function getMeeting(id: string): Promise<ChimeMeeting | null> {
  try {
    const raw = await call("meetings", "GET", `/meetings/${encodeURIComponent(id)}`);
    return raw.Meeting as ChimeMeeting;
  } catch (err) {
    if (err instanceof ChimeError && err.status === 404) return null;
    throw err;
  }
}

export async function deleteMeeting(id: string): Promise<void> {
  try {
    await call("meetings", "DELETE", `/meetings/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ChimeError && err.status === 404) return;
    throw err;
  }
}

export async function createAttendee(
  meetingId: string,
  externalUserId: string,
  capabilities: { Audio: string; Video: string; Content: string },
) {
  const raw = await call("meetings", "POST", `/meetings/${encodeURIComponent(meetingId)}/attendees`, {
    ExternalUserId: externalUserId,
    Capabilities: capabilities,
  });
  return raw.Attendee as { AttendeeId: string; ExternalUserId: string; JoinToken: string };
}

/** Sends the meeting (grid of cameras + shared screen, mixed audio) to an RTMP address. */
export async function startLiveConnector(args: { meetingArn: string; rtmpUrl: string; token: string }) {
  const raw = await call("pipelines", "POST", "/sdk-media-live-connector-pipelines", {
    ClientRequestToken: args.token,
    Sources: [
      {
        SourceType: "ChimeSdkMeeting",
        ChimeSdkMeetingLiveConnectorConfiguration: {
          Arn: args.meetingArn,
          MuxType: "AudioWithCompositedVideo",
          CompositedVideo: {
            Layout: "GridView",
            Resolution: "FHD",
            GridViewConfiguration: { ContentShareLayout: "PresenterOnly" },
          },
        },
      },
    ],
    Sinks: [
      {
        SinkType: "RTMP",
        RTMPConfiguration: { Url: args.rtmpUrl, AudioChannels: "Stereo", AudioSampleRate: "48000" },
      },
    ],
  });
  const p = raw.MediaLiveConnectorPipeline ?? raw;
  return { pipelineId: String(p.MediaPipelineId) };
}

export async function stopMediaPipeline(id: string): Promise<void> {
  try {
    await call("pipelines", "DELETE", `/sdk-media-pipelines/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ChimeError && err.status === 404) return;
    throw err;
  }
}

/** Seats currently held in a meeting (people who left via the Leave button are removed). */
export async function countAttendees(meetingId: string): Promise<number> {
  let total = 0;
  let next: string | undefined;
  for (let page = 0; page < 10; page++) {
    const qs = `?max-results=100${next ? `&next-token=${encodeURIComponent(next)}` : ""}`;
    const raw = await call("meetings", "GET", `/meetings/${encodeURIComponent(meetingId)}/attendees${qs}`);
    total += (raw.Attendees ?? []).length;
    next = raw.NextToken;
    if (!next) break;
  }
  return total;
}

export async function updateAttendeeCapabilities(
  meetingId: string, attendeeId: string, capabilities: { Audio: string; Video: string; Content: string },
): Promise<void> {
  await call("meetings", "PUT", `/meetings/${encodeURIComponent(meetingId)}/attendees/${encodeURIComponent(attendeeId)}/capabilities`, { Capabilities: capabilities });
}

export async function deleteAttendee(meetingId: string, attendeeId: string): Promise<void> {
  try {
    await call("meetings", "DELETE", `/meetings/${encodeURIComponent(meetingId)}/attendees/${encodeURIComponent(attendeeId)}`);
  } catch (err) {
    if (err instanceof ChimeError && err.status === 404) return;
    throw err;
  }
}

// ---------- Recording (media capture + concatenation) and live transcription ----------

/** Private bucket for meeting recordings (created by the AWS setup script). */
export function recordingsBucket(): string {
  const b = process.env.MEETING_RECORDINGS_BUCKET?.trim();
  if (!b) throw new Error("Meeting recordings storage isn't configured.");
  return b;
}

/** Turns on Amazon Transcribe for the meeting — every word is credited to the person who said it. */
export async function startMeetingTranscription(meetingId: string): Promise<void> {
  try {
    await call("meetings", "POST", `/meetings/${encodeURIComponent(meetingId)}/transcription?operation=start`, {
      TranscriptionConfiguration: {
        EngineTranscribeSettings: { LanguageCode: "en-US" },
      },
    });
  } catch (err) {
    // 409 = already running for this meeting; that's fine.
    if (err instanceof ChimeError && err.status === 409) return;
    throw err;
  }
}

export async function stopMeetingTranscription(meetingId: string): Promise<void> {
  try {
    await call("meetings", "POST", `/meetings/${encodeURIComponent(meetingId)}/transcription?operation=stop`, {});
  } catch (err) {
    if (err instanceof ChimeError && (err.status === 404 || err.status === 409 || err.status === 400)) return;
    throw err;
  }
}

/**
 * Starts saving the meeting to S3 in 5-second pieces. With video on, it records
 * the same grid + shared screen view as the live stream; without video it keeps
 * only the sound (needed so the transcript pieces are saved too).
 */
export async function createCapturePipeline(args: {
  meetingArn: string;
  prefix: string;
  video: boolean;
  token: string;
}): Promise<{ pipelineId: string; pipelineArn: string }> {
  const bucket = recordingsBucket();
  const raw = await call("pipelines", "POST", "/sdk-media-capture-pipelines", {
    ClientRequestToken: args.token,
    SourceType: "ChimeSdkMeeting",
    SourceArn: args.meetingArn,
    SinkType: "S3Bucket",
    SinkArn: `arn:aws:s3:::${bucket}/${args.prefix}`,
    ChimeSdkMeetingConfiguration: {
      ArtifactsConfiguration: args.video
        ? {
            Audio: { MuxType: "AudioWithCompositedVideo" },
            Video: { State: "Disabled" },
            Content: { State: "Disabled" },
            CompositedVideo: {
              Layout: "GridView",
              Resolution: "FHD",
              GridViewConfiguration: { ContentShareLayout: "PresenterOnly" },
            },
          }
        : {
            Audio: { MuxType: "AudioOnly" },
            Video: { State: "Disabled" },
            Content: { State: "Disabled" },
          },
    },
  });
  const p = raw.MediaCapturePipeline ?? raw;
  return { pipelineId: String(p.MediaPipelineId), pipelineArn: String(p.MediaPipelineArn) };
}

/**
 * Joins the 5-second pieces into one video file and one transcript file once
 * capture stops. Created up front — AWS waits for the capture to finish.
 */
export async function createConcatPipeline(args: {
  capturePipelineArn: string;
  prefix: string;
  video: boolean;
  notes: boolean;
  token: string;
}): Promise<{ pipelineId: string }> {
  const bucket = recordingsBucket();
  const on = (b: boolean) => ({ State: b ? "Enabled" : "Disabled" });
  const raw = await call("pipelines", "POST", "/sdk-media-concatenation-pipelines", {
    ClientRequestToken: args.token,
    Sources: [
      {
        Type: "MediaCapturePipeline",
        MediaCapturePipelineSourceConfiguration: {
          MediaPipelineArn: args.capturePipelineArn,
          ChimeSdkMeetingConfiguration: {
            ArtifactsConfiguration: {
              Audio: { State: "Enabled" },
              Video: on(false),
              Content: on(false),
              DataChannel: on(false),
              TranscriptionMessages: on(args.notes),
              MeetingEvents: on(false),
              CompositedVideo: on(args.video),
            },
          },
        },
      },
    ],
    Sinks: [
      {
        Type: "S3Bucket",
        S3BucketSinkConfiguration: { Destination: `arn:aws:s3:::${bucket}/${args.prefix}` },
      },
    ],
  });
  const p = raw.MediaConcatenationPipeline ?? raw;
  return { pipelineId: String(p.MediaPipelineId) };
}

/** Status of any media pipeline ("InProgress", "Stopped", "Failed", …) or null if AWS no longer knows it. */
export async function getMediaPipelineStatus(id: string): Promise<string | null> {
  try {
    const raw = await call("pipelines", "GET", `/sdk-media-pipelines/${encodeURIComponent(id)}`);
    const mp = raw.MediaPipeline ?? {};
    const inner = mp.MediaConcatenationPipeline ?? mp.MediaCapturePipeline ?? mp.MediaLiveConnectorPipeline ?? {};
    return inner.Status ? String(inner.Status) : null;
  } catch (err) {
    if (err instanceof ChimeError && err.status === 404) return null;
    throw err;
  }
}
