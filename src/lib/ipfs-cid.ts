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

/**
 * HEAD our own /api/stream/:cid (which 302s to the configured Pinata
 * gateway via PINATA_GATEWAY_DOMAIN). Returns true if the file already
 * resolves there (someone else pinned it). 8s timeout. Routing through
 * our endpoint keeps the gateway domain in one server-side secret.
 */
export async function isCidOnIpfs(cid: string): Promise<boolean> {
  const url = `/api/stream/${cid}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8_000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Probe IPFS for a file under BOTH its CIDv1 and CIDv0 forms in parallel.
 * Returns the first CID that resolves, or null if neither does.
 */
export async function findCidOnIpfs(cids: {
  v1: string;
  v0: string;
}): Promise<{ cid: string; version: 0 | 1 } | null> {
  const [v1Hit, v0Hit] = await Promise.all([
    isCidOnIpfs(cids.v1),
    isCidOnIpfs(cids.v0),
  ]);
  // Prefer v1 since it matches what we'd upload as.
  if (v1Hit) return { cid: cids.v1, version: 1 };
  if (v0Hit) return { cid: cids.v0, version: 0 };
  return null;
}