// Browser-side CID computation. Mirrors Pinata's defaults:
//   cidVersion: 1, rawLeaves: true, chunker: 256 KiB.
// Lets us check "is this file already on IPFS?" before uploading the bytes.
//
// We compute BOTH CIDv1 (current Pinata default — rawLeaves:true) AND CIDv0
// (legacy default — rawLeaves:false, dag-pb leaves) because the same bytes
// produce different CIDs under each scheme, and a file pinned by an older
// client (or by `ipfs add` with default flags) will only resolve under v0.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - direct file import bypasses Vite's node:buffer externalization
import { Buffer as BufferPolyfill } from "buffer/index.js";
import Hash from "ipfs-only-hash";

// ipfs-only-hash uses Node's Buffer internally. In the browser there is no
// Buffer global, so install the polyfill lazily the first time we hash.
function ensureBuffer(): void {
  const g = globalThis as { Buffer?: unknown };
  if (typeof g.Buffer === "undefined") {
    g.Buffer = BufferPolyfill;
  }
}

export async function computeCidV1(file: File | Blob): Promise<string> {
  ensureBuffer();
  const buf = new Uint8Array(await file.arrayBuffer());
  return Hash.of(buf, { cidVersion: 1, rawLeaves: true });
}

export async function computeCidV0(file: File | Blob): Promise<string> {
  ensureBuffer();
  const buf = new Uint8Array(await file.arrayBuffer());
  return Hash.of(buf, { cidVersion: 0, rawLeaves: false });
}

/** Compute both CIDv1 (Pinata default) and CIDv0 (legacy `ipfs add` default). */
export async function computeCids(
  file: File | Blob,
): Promise<{ v1: string; v0: string }> {
  ensureBuffer();
  const buf = new Uint8Array(await file.arrayBuffer());
  const [v1, v0] = await Promise.all([
    Hash.of(buf, { cidVersion: 1, rawLeaves: true }),
    Hash.of(buf, { cidVersion: 0, rawLeaves: false }),
  ]);
  return { v1, v0 };
}

// Note: a previous helper here HEAD-probed /api/stream/:cid to check if a CID
// was "on IPFS". That was unreliable — the stream endpoint 302s to a host
// that returns the SPA shell as 200 for unknown CIDs, producing false hits.
// Use the `lookupPinnedCid` server fn in videos.functions.ts instead, which
// queries our Pinata account directly.