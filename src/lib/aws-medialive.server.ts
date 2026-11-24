// AWS MediaLive control-plane wrapper (start/stop/describe) via aws4fetch.
// Kept Worker-friendly by avoiding the official AWS SDK.

import { AwsClient } from "aws4fetch";

function region() {
  return process.env.MEDIALIVE_REGION ?? process.env.AWS_REGION ?? "us-east-1";
}

function aws() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS not configured: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing");
  }
  const r = region();
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, region: r, service: "medialive" }),
    region: r,
  };
}

function mpClient() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS not configured");
  }
  const r = region();
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, region: r, service: "mediapackage" }),
    region: r,
  };
}

function channelId() {
  const id = process.env.MEDIALIVE_CHANNEL_ID;
  if (!id) throw new Error("MEDIALIVE_CHANNEL_ID not configured");
  return id;
}

async function call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const { client, region } = aws();
  const url = `https://medialive.${region}.amazonaws.com${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init as any).headers = { "content-type": "application/json" };
  }
  const res = await client.fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MediaLive ${method} ${path} failed [${res.status}]: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function mpCall(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const { client, region } = mpClient();
  const url = `https://mediapackage.${region}.amazonaws.com${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init as any).headers = { "content-type": "application/json" };
  }
  const res = await client.fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MediaPackage ${method} ${path} failed [${res.status}]: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

export interface MediaLiveChannelState {
  state: string; // IDLE | STARTING | RUNNING | STOPPING | ...
  raw: any;
}

export async function describeChannel(id?: string): Promise<MediaLiveChannelState> {
  const raw = await call("GET", `/prod/channels/${id ?? channelId()}`);
  return { state: String(raw.state ?? "UNKNOWN"), raw };
}

export async function startChannel(id?: string): Promise<MediaLiveChannelState> {
  const raw = await call("POST", `/prod/channels/${id ?? channelId()}/start`);
  return { state: String(raw.state ?? "STARTING"), raw };
}

export async function stopChannel(id?: string): Promise<MediaLiveChannelState> {
  const raw = await call("POST", `/prod/channels/${id ?? channelId()}/stop`);
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

// ---------- Provisioning (Phase B) ----------

export async function createRtmpInput(args: {
  name: string;
  streamName: string; // e.g. `wallet-abc123/primary`
  securityGroupId: string;
}): Promise<{ inputId: string; destinations: string[] }> {
  const sg = await ensureInputSecurityGroup(args.securityGroupId);
  const raw = await call("POST", `/prod/inputs`, {
    name: args.name,
    type: "RTMP_PUSH",
    inputSecurityGroups: [sg],
    destinations: [{ streamName: args.streamName }],
    requestId: `input-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  });
  const input = raw?.input ?? raw;
  const destinations = Array.isArray(input?.destinations)
    ? input.destinations.map((d: any) => String(d?.url ?? "")).filter(Boolean)
    : [];
  return { inputId: String(input?.id), destinations };
}

// Resolves the input security group for new inputs. Uses the configured id
// when it exists, otherwise the group our existing inputs already use. It
// never creates a new open-to-the-world group on its own: stream keys are
// random and secret, and any change to who may connect is a deliberate step.
export async function ensureInputSecurityGroup(preferredId?: string): Promise<string> {
  if (preferredId) {
    try {
      await call("GET", `/prod/inputSecurityGroups/${preferredId}`);
      return preferredId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not found|404/i.test(msg)) throw err;
      console.warn(`[medialive] InputSecurityGroup ${preferredId} not found; using the one in use`);
    }
  }
  const list = await call("GET", `/prod/inputSecurityGroups`);
  const groups: any[] = Array.isArray(list?.inputSecurityGroups) ? list.inputSecurityGroups : [];
  const inUse = groups.find((g) => Array.isArray(g?.inputs) && g.inputs.length > 0) ?? groups[0];
  if (inUse?.id) return String(inUse.id);
  throw new Error("No MediaLive input security group exists yet — set one up in AWS first.");
}

/**
 * Give an RTMP input a brand-new random stream key (keeps the same server
 * address). Only allowed while its channel is stopped, because a running
 * encoder would be cut off mid-stream.
 */
export async function rotateRtmpStreamKey(args: {
  inputId: string;
  channelId: string;
  newKey: string;
}): Promise<{ serverUrl: string; streamKey: string }> {
  const ch = await describeChannel(args.channelId);
  if (ch.state !== "IDLE") {
    throw new Error("Stop the live channel first (it must be fully off) before making a new stream key.");
  }
  const { destinations } = await describeInput(args.inputId);
  if (!destinations.length) throw new Error("This live input has no RTMP address to update.");
  const apps = destinations.map((full) => {
    const m = full.match(/^rtmps?:\/\/[^/]+\/([^/]+)\//i);
    return m?.[1] ?? "live";
  });
  let raw: any;
  try {
    raw = await call("PUT", `/prod/inputs/${args.inputId}`, {
      destinations: apps.map((app) => ({ streamName: `${app}/${args.newKey}` })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\[403\]/.test(msg)) {
      throw new Error("Amazon hasn't allowed changing stream keys yet — the one-time AWS setup step still needs to be run.");
    }
    throw err;
  }
  const input = raw?.input ?? raw;
  const urls: string[] = Array.isArray(input?.destinations)
    ? input.destinations.map((d: any) => String(d?.url ?? "")).filter(Boolean)
    : [];
  const first = urls[0] ?? "";
  const idx = first.lastIndexOf("/");
  if (idx < 0 || first.slice(idx + 1) !== args.newKey) {
    throw new Error("AWS didn't accept the new stream key — nothing was changed.");
  }
  return { serverUrl: first.slice(0, idx), streamKey: args.newKey };
}

export async function deleteInput(inputId: string) {
  await call("DELETE", `/prod/inputs/${inputId}`).catch(() => null);
}

export async function createMediaLiveChannel(args: {
  name: string;
  roleArn: string;
  inputId: string;
  encoderSettings: unknown;
  destinations: unknown;
  inputSpecification: unknown;
}): Promise<{ channelId: string; raw: any }> {
  const raw = await call("POST", `/prod/channels`, {
    name: args.name,
    channelClass: "SINGLE_PIPELINE",
    roleArn: args.roleArn,
    requestId: `channel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    inputAttachments: [
      {
        inputId: args.inputId,
        inputAttachmentName: "primary",
        inputSettings: { sourceEndBehavior: "CONTINUE" },
      },
    ],
    inputSpecification: args.inputSpecification,
    destinations: args.destinations,
    encoderSettings: args.encoderSettings,
  });
  const ch = raw?.channel ?? raw;
  return { channelId: String(ch?.id), raw: ch };
}

export async function deleteMediaLiveChannel(id: string) {
  await call("DELETE", `/prod/channels/${id}`).catch(() => null);
}

export async function listRunningChannelIds(): Promise<string[]> {
  const raw = await call("GET", `/prod/channels?maxResults=100`);
  const list = Array.isArray(raw?.channels) ? raw.channels : [];
  return list
    .filter((c: any) => c?.state === "RUNNING" || c?.state === "STARTING")
    .map((c: any) => String(c.id));
}

// ---------- MediaPackage ----------

export async function createMediaPackageChannel(id: string): Promise<{ channelId: string }> {
  const raw = await mpCall("POST", `/channels`, { id, description: `streamTXC live channel ${id}` });
  return { channelId: String(raw?.id ?? id) };
}

export async function deleteMediaPackageChannel(id: string) {
  await mpCall("DELETE", `/channels/${id}`).catch(() => null);
}

export async function createHlsOriginEndpoint(args: {
  id: string;
  channelId: string;
}): Promise<{ endpointId: string; url: string }> {
  const raw = await mpCall("POST", `/origin_endpoints`, {
    id: args.id,
    channelId: args.channelId,
    manifestName: "index",
    startoverWindowSeconds: 3600,
    hlsPackage: {
      segmentDurationSeconds: 4,
      playlistWindowSeconds: 60,
      playlistType: "EVENT",
      adMarkers: "NONE",
      includeIframeOnlyStream: false,
    },
  });
  return { endpointId: String(raw?.id ?? args.id), url: String(raw?.url ?? "") };
}

export async function deleteHlsOriginEndpoint(id: string) {
  await mpCall("DELETE", `/origin_endpoints/${id}`).catch(() => null);
}
/**
 * Rewrite a channel's destinations + encoder settings (used for restream
 * outputs). AWS only allows this while the channel is fully off.
 */
export async function updateChannelRestream(
  id: string,
  transform: (destinations: any[], encoderSettings: any) => { destinations: any[]; encoderSettings: any },
): Promise<void> {
  const { state, raw } = await describeChannel(id);
  if (state !== "IDLE") {
    throw new Error("Turn your live channel fully off first — AWS only accepts new destinations while it's stopped.");
  }
  const next = transform(raw.destinations ?? [], raw.encoderSettings ?? {});
  try {
    await call("PUT", `/prod/channels/${id}`, { destinations: next.destinations, encoderSettings: next.encoderSettings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\[403\]/.test(msg)) throw new Error("Amazon hasn't allowed updating the live channel yet — a one-time AWS permission (UpdateChannel) is needed.");
    if (/\[4\d\d\]/.test(msg)) throw new Error("Amazon rejected one of the destinations — check the server URL and stream key.");
    throw err;
  }
}
