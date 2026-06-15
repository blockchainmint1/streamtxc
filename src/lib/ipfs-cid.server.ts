import Hash from "ipfs-only-hash";

export type ComputedCids = { v1: string; v0: string };

export async function computeIpfsCids(file: Blob): Promise<ComputedCids> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [v1, v0] = await Promise.all([
    Hash.of(bytes, { cidVersion: 1, rawLeaves: true }),
    Hash.of(bytes, { cidVersion: 0, rawLeaves: false }),
  ]);

  return { v1, v0 };
}