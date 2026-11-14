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
