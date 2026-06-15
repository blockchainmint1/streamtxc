// Client-safe helper for IPFS gateway URLs.
// We deliberately route through our own /api/stream/:cid endpoint instead of
// hitting a public gateway directly. That endpoint 302-redirects to whatever
// gatewayUrl() in pinata.server.ts resolves to, which honors the
// PINATA_GATEWAY_DOMAIN secret. One env var controls every gateway hit
// (thumbnails, CID existence probes, video stream redirects).

export function ipfsThumbUrl(cid: string | null | undefined): string | undefined {
  if (!cid) return undefined;
  return `/api/stream/${cid}`;
}

/**
 * Build the HLS master-playlist URL for a transcoded video's directory CID.
 * Returns `undefined` when there's no HLS bundle yet, so callers can fall back
 * to the legacy single-MP4 path.
 */
export function ipfsHlsUrl(hlsCid: string | null | undefined): string | undefined {
  if (!hlsCid) return undefined;
  return `/api/stream/${hlsCid}/master.m3u8`;
}