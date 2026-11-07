// Who may upload a conversion source / start a conversion for a CID.
// Owner: always. Anyone else: only a brand-new video that has never been
// converted (the anonymous upload flow), never an existing video.

export const FRESH_UPLOAD_WINDOW_MS = 6 * 60 * 60 * 1000;

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/;
export function isValidCid(cid: string): boolean {
  return CID_RE.test(cid);
}

export type TranscodeGuardRow = {
  owner_wallet: string | null;
  hls_cid: string | null;
  transcode_status: string | null;
  created_at: string;
};

function same(a: string, b: string) {
  return a.startsWith("0x") || b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function transcodeAllowed(
  row: TranscodeGuardRow | null,
  wallet: string | null,
  now: number,
): { ok: true } | { ok: false; reason: string } {
  if (!row) return { ok: true }; // not registered yet — first upload
  if (row.owner_wallet && wallet && same(row.owner_wallet, wallet)) return { ok: true };
  if (row.owner_wallet && !wallet) {
    return { ok: false, reason: "Sign in with the wallet that owns this video." };
  }
  if (row.owner_wallet) return { ok: false, reason: "This video belongs to another wallet." };
  if (row.hls_cid || row.transcode_status === "processing" || row.transcode_status === "complete") {
    return { ok: false, reason: "This video has already been converted." };
  }
  if (now - new Date(row.created_at).getTime() > FRESH_UPLOAD_WINDOW_MS) {
    return { ok: false, reason: "This video is no longer accepting a new source file." };
  }
  return { ok: true };
}
