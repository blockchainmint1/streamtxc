// Client-safe helper for IPFS gateway URLs.
// We deliberately route through our own /api/stream/:cid endpoint instead of
// hitting a public gateway directly. That endpoint 302-redirects to whatever
// gatewayUrl() in ipfs.server.ts resolves to. The self-hosted gateway controls every hit
// (thumbnails, CID existence probes, video stream redirects).

const GATEWAY_CACHE_VERSION = "self-20260805";

export function ipfsStreamUrl(cid: string): string {
  return `/api/stream/${cid}?gateway=${GATEWAY_CACHE_VERSION}`;
}

export function ipfsThumbUrl(cid: string | null | undefined): string | undefined {
  if (!cid) return undefined;
  return ipfsStreamUrl(cid);
}

/**
 * Build the HLS master-playlist URL for a transcoded video's directory CID.
 * Returns `undefined` when there's no HLS bundle yet, so callers can fall back
 * to the legacy single-MP4 path.
 */
export function ipfsHlsUrl(
  hlsCid: string | null | undefined,
  sourceCid?: string | null | undefined,
): string | undefined {
  if (!hlsCid) return undefined;
  if (sourceCid) {
    return `/api/stream/${hlsCid}/hls/${sourceCid}/${sourceCid}.m3u8?gateway=${GATEWAY_CACHE_VERSION}`;
  }
  return `/api/stream/${hlsCid}/master.m3u8?gateway=${GATEWAY_CACHE_VERSION}`;
}

/**
 * Live-stream archives are transcoded under `hls/live-<streamId>/` with a
 * MediaConvert-named master (e.g. `index_720p.m3u8`), so the regular
 * `hls/<cid>/<cid>.m3u8` convention doesn't apply. Derive the master from
 * the stored renditions: variant playlists are the master's basename plus
 * a `-<height>p` suffix.
 */
export function hlsUrlForVideo(video: {
  cid?: string | null;
  hls_cid?: string | null;
  source?: string | null;
  live_stream_id?: string | null;
  renditions?: unknown;
} | null | undefined): string | undefined {
  if (!video?.hls_cid) return undefined;

  const renditions = Array.isArray(video.renditions)
    ? (video.renditions as Array<{ playlist?: string }>)
    : [];
  const names = renditions
    .map((r) => r?.playlist)
    .filter((p): p is string => typeof p === "string" && p.endsWith(".m3u8"));

  if (video.source === "live-archive" && video.live_stream_id && names.length) {
    const master =
      names.find((n) =>
        names.some((o) => o !== n && o.startsWith(`${n.replace(/\.m3u8$/, "")}-`)),
      ) ?? names[0];
    return `/api/stream/${video.hls_cid}/hls/live-${video.live_stream_id}/${master}?gateway=${GATEWAY_CACHE_VERSION}`;
  }

  return ipfsHlsUrl(video.hls_cid, video.cid);
}