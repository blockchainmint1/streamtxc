// Tracks CIDs of videos uploaded from this browser without a wallet, so
// the user can later claim ownership of them via /manage. Pure client.

const KEY = "txc:anon-uploads";
const MAX = 100;

export interface AnonUploadRecord {
  cid: string;
  title: string;
  uploadedAt: number;
}

function read(): AnonUploadRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.cid === "string") : [];
  } catch {
    return [];
  }
}

function write(rows: AnonUploadRecord[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(rows.slice(-MAX)));
  window.dispatchEvent(new Event("txc:anon-uploads-changed"));
}

export function recordAnonUpload(cid: string, title: string) {
  const rows = read().filter((r) => r.cid !== cid);
  rows.push({ cid, title, uploadedAt: Date.now() });
  write(rows);
}

export function removeAnonUpload(cid: string) {
  write(read().filter((r) => r.cid !== cid));
}

export function listAnonUploads(): AnonUploadRecord[] {
  return read().sort((a, b) => b.uploadedAt - a.uploadedAt);
}

export function subscribeToAnonUploads(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const handler = () => onChange();
  window.addEventListener("txc:anon-uploads-changed", handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("txc:anon-uploads-changed", handler);
    window.removeEventListener("storage", handler);
  };
}
