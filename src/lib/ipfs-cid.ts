// Browser-safe compatibility wrapper. The actual IPFS hash library is
// Node-style CommonJS and depends on Buffer/protobuf internals, so browser
// callers compute CIDs through our same-origin API instead of bundling it.
import { computeCids } from "./cid-client";

export { computeCids };

export async function computeCidV1(file: File): Promise<string> {
  return (await computeCids(file)).v1;
}

export async function computeCidV0(file: File): Promise<string> {
  return (await computeCids(file)).v0;
}

// Note: a previous helper here HEAD-probed /api/stream/:cid to check if a CID
// was "on IPFS". That was unreliable — the stream endpoint 302s to a host
// that returns the SPA shell as 200 for unknown CIDs, producing false hits.
// Use the `lookupPinnedCid` server fn in videos.functions.ts instead, which
// queries our Pinata account directly.