// AWS MediaLive control-plane wrapper (start/stop/describe) via aws4fetch.
// Kept Worker-friendly by avoiding the official AWS SDK.

import { AwsClient } from "aws4fetch";

function aws() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.MEDIALIVE_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS not configured: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing");
  }
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, region, service: "medialive" }),
    region,
  };
}

function channelId() {
  const id = process.env.MEDIALIVE_CHANNEL_ID;
  if (!id) throw new Error("MEDIALIVE_CHANNEL_ID not configured");
  return id;
}

async function call(method: "GET" | "POST", path: string) {
  const { client, region } = aws();
  const url = `https://medialive.${region}.amazonaws.com${path}`;
  const res = await client.fetch(url, { method });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MediaLive ${method} ${path} failed [${res.status}]: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

export interface MediaLiveChannelState {
  state: string; // IDLE | STARTING | RUNNING | STOPPING | ...
  raw: any;
}

export async function describeChannel(): Promise<MediaLiveChannelState> {
  const raw = await call("GET", `/prod/channels/${channelId()}`);
  return { state: String(raw.state ?? "UNKNOWN"), raw };
}

export async function startChannel(): Promise<MediaLiveChannelState> {
  const raw = await call("POST", `/prod/channels/${channelId()}/start`);
  return { state: String(raw.state ?? "STARTING"), raw };
}

export async function stopChannel(): Promise<MediaLiveChannelState> {
  const raw = await call("POST", `/prod/channels/${channelId()}/stop`);
  return { state: String(raw.state ?? "STOPPING"), raw };
}

export async function describeInput(inputId?: string): Promise<{ destinations: string[]; raw: any }> {
  const id = inputId ?? process.env.MEDIALIVE_INPUT_ID;
  if (!id) throw new Error("MEDIALIVE_INPUT_ID not configured");
  const raw = await call("GET", `/prod/inputs/${id}`);
  const destinations = Array.isArray(raw?.destinations)
    ? raw.destinations.map((d: any) => String(d?.url ?? "")).filter(Boolean)
    : [];
  return { destinations, raw };
}