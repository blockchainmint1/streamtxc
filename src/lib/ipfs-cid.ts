// Browser-side CID computation. Mirrors Pinata's defaults:
//   cidVersion: 1, rawLeaves: true, chunker: 256 KiB.
// Lets us check "is this file already on IPFS?" before uploading the bytes.
//
// We compute BOTH CIDv1 (current Pinata default — rawLeaves:true) AND CIDv0
// (legacy default — rawLeaves:false, dag-pb leaves) because the same bytes
// produce different CIDs under each scheme, and a file pinned by an older
// client (or by `ipfs add` with default flags) will only resolve under v0.
import Hash from "ipfs-only-hash";

export async function computeCidV1(file: File | Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return Hash.of(buf, { cidVersion: 1, rawLeaves: true });
}

export async function computeCidV0(file: File | Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return Hash.of(buf, { cidVersion: 0, rawLeaves: false });
}

/** Compute both CIDv1 (Pinata default) and CIDv0 (legacy `ipfs add` default). */
export async function computeCids(
  file: File | Blob,
): Promise<{ v1: string; v0: string }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const [v1, v0] = await Promise.all([
    Hash.of(buf, { cidVersion: 1, rawLeaves: true }),
    Hash.of(buf, { cidVersion: 0, rawLeaves: false }),
  ]);
  return { v1, v0 };
}

// IPFS reachability probing happens server-side via the `probeCidOnIpfs`
// server function — the browser never hits a gateway directly.