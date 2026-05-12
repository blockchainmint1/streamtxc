// Browser-side CID computation. Mirrors Pinata's defaults:
//   cidVersion: 1, rawLeaves: true, chunker: 256 KiB.
// Lets us check "is this file already on IPFS?" before uploading the bytes.
import Hash from "ipfs-only-hash";

export async function computeCidV1(file: File | Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return Hash.of(buf, { cidVersion: 1, rawLeaves: true });
}

/**
 * HEAD the public Pinata gateway for this CID. Returns true if the file
 * already resolves there (someone else pinned it). 8s timeout.
 */
export async function isCidOnIpfs(cid: string): Promise<boolean> {
  const url = `https://gateway.pinata.cloud/ipfs/${cid}`;
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