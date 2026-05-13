// Client-safe helpers. The browser must NEVER hit IPFS gateways directly
// (a hardcoded public gateway breaks when ops switch to a private cluster,
// and a localhost gateway breaks for everyone except the developer running
// it). Always go through our own backend route, which proxies the bytes
// with gateway fallback.

export function ipfsBackendUrl(
  cid: string | null | undefined,
): string | undefined {
  if (!cid) return undefined;
  return `/api/stream/${cid}`;
}

/** Back-compat alias used by thumbnail consumers. */
export const ipfsThumbUrl = ipfsBackendUrl;