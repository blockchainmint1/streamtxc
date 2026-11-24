// Multi-destination ("restream") rules: presets, validation and the
// MediaLive output-group JSON. Pure — safe to import anywhere and to test.

export const MAX_RESTREAM_DESTINATIONS = 5;
export const RESTREAM_GROUP_NAME = "restream";
export const RESTREAM_DEST_PREFIX = "restream-";

export type RestreamPlatform = "youtube" | "facebook" | "twitch" | "custom";

export const RESTREAM_PRESETS: Record<RestreamPlatform, { label: string; serverUrl: string; help: string }> = {
  youtube: {
    label: "YouTube",
    serverUrl: "rtmp://a.rtmp.youtube.com/live2",
    help: "YouTube Studio → Go live → Stream → copy the Stream key.",
  },
  facebook: {
    label: "Facebook",
    serverUrl: "rtmps://live-api-s.facebook.com:443/rtmp",
    help: "Facebook → Live Producer → Streaming software → copy the Stream key.",
  },
  twitch: {
    label: "Twitch",
    serverUrl: "rtmp://live.twitch.tv/app",
    help: "Twitch Creator Dashboard → Settings → Stream → copy the Primary stream key.",
  },
  custom: {
    label: "Other (X, Rumble, LinkedIn, Kick…)",
    serverUrl: "",
    help: "Paste the server URL and stream key the site gives you for streaming software.",
  },
};

/** rtmp:// or rtmps:// with a host and an app path; nothing else. */
export function validateServerUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, "");
  const m = url.match(/^(rtmps?):\/\/([a-z0-9.-]+)(:\d{2,5})?(\/[^\s?#]*)$/i);
  if (!m || !m[4] || m[4] === "/") throw new Error("Server URL must look like rtmp://host/app or rtmps://host/app.");
  if (url.length > 300) throw new Error("Server URL is too long.");
  return url;
}

export function validateStreamKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 4 || key.length > 400 || /\s/.test(key)) throw new Error("That stream key doesn't look right.");
  return key;
}

/** Show only the last 4 characters of a key. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

export interface RestreamTarget { serverUrl: string; streamKey: string }

/**
 * Take a channel's current destinations + encoder settings and return them
 * with exactly one "restream" RTMP output group for `targets` (or none when
 * empty). Everything that isn't ours is left untouched.
 */
export function withRestreamOutputs(
  destinations: any[],
  encoderSettings: any,
  targets: RestreamTarget[],
): { destinations: any[]; encoderSettings: any } {
  if (targets.length > MAX_RESTREAM_DESTINATIONS) throw new Error(`At most ${MAX_RESTREAM_DESTINATIONS} destinations.`);
  const keptDest = (destinations ?? []).filter((d) => !String(d?.id ?? "").startsWith(RESTREAM_DEST_PREFIX));
  const groups: any[] = (encoderSettings?.outputGroups ?? []).filter((g: any) => g?.name !== RESTREAM_GROUP_NAME);
  if (!targets.length) return { destinations: keptDest, encoderSettings: { ...encoderSettings, outputGroups: groups } };

  const vids: any[] = encoderSettings?.videoDescriptions ?? [];
  const video = vids.find((v) => v?.height === 720) ?? vids.find((v) => /720/.test(String(v?.name))) ?? vids[0];
  const audio = (encoderSettings?.audioDescriptions ?? [])[0];
  if (!video?.name || !audio?.name) throw new Error("This live channel has no video/audio settings to copy.");

  const newDest = targets.map((t, i) => ({
    id: `${RESTREAM_DEST_PREFIX}${i + 1}`,
    mediaPackageSettings: [],
    settings: [{ url: t.serverUrl, streamName: t.streamKey }],
  }));
  const group = {
    name: RESTREAM_GROUP_NAME,
    outputGroupSettings: {
      rtmpGroupSettings: {
        authenticationScheme: "COMMON",
        cacheLength: 30,
        restartDelay: 15,
        cacheFullBehavior: "DISCONNECT_IMMEDIATELY",
        inputLossAction: "EMIT_OUTPUT",
        captionData: "ALL",
      },
    },
    outputs: targets.map((_, i) => ({
      outputName: `restream_${i + 1}`,
      videoDescriptionName: video.name,
      audioDescriptionNames: [audio.name],
      outputSettings: {
        rtmpOutputSettings: {
          destination: { destinationRefId: `${RESTREAM_DEST_PREFIX}${i + 1}` },
          connectionRetryInterval: 2,
          numRetries: 10,
          certificateMode: "VERIFY_AUTHENTICITY",
        },
      },
    })),
  };
  return {
    destinations: [...keptDest, ...newDest],
    encoderSettings: { ...encoderSettings, outputGroups: [...groups, group] },
  };
}
