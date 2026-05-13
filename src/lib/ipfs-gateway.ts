// Tiny client-safe helper for building public IPFS gateway URLs.
// Server-side code already has gatewayUrl() in pinata.server.ts (which can
// use the project's custom Pinata domain via env). The browser doesn't
// need that domain at all — pinata's public gateway works fine for
// thumbnails and is cached aggressively by the CDN.

const PUBLIC_GATEWAY = "https://gateway.pinata.cloud";

export function ipfsThumbUrl(cid: string | null | undefined): string | undefined {
  if (!cid) return undefined;
  return `${PUBLIC_GATEWAY}/ipfs/${cid}`;
}