export type DuplicateCidInfo = {
  cid: string;
  ownerWallet: string;
  title: string;
  createdAt: string;
  txHash: string | null;
};

/**
 * Server functions throw `new Error("DUPLICATE_CID:" + JSON.stringify(info))`
 * when someone tries to register a CID that's already on the platform.
 * This helper extracts the structured details, or returns null if the error
 * is something else.
 */
export function parseDuplicateCidError(err: unknown): DuplicateCidInfo | null {
  if (!(err instanceof Error)) return null;
  const idx = err.message.indexOf("DUPLICATE_CID:");
  if (idx < 0) return null;
  try {
    return JSON.parse(err.message.slice(idx + "DUPLICATE_CID:".length)) as DuplicateCidInfo;
  } catch {
    return null;
  }
}

export function shortWallet(w: string) {
  if (w.length <= 12) return w;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}