// TXC pricing for video hosting.
// Quote = sizeMB * RATE_PER_MB * monthsPrepaid

export const RATE_PER_MB_PER_MONTH = 0.05; // TXC
export const REWARD_CREDIT_PER_VIEW = 0.001; // TXC equivalent
export const VIEW_DEBOUNCE_SECONDS = 30;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB cap

export function quoteFee(sizeBytes: number, months = 1): number {
  const sizeMB = sizeBytes / (1024 * 1024);
  return Math.max(0.01, +(sizeMB * RATE_PER_MB_PER_MONTH * months).toFixed(4));
}

export function formatTxc(amount: number | string): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} TXC`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function shortenHash(hash: string, head = 6, tail = 4): string {
  if (!hash) return "";
  if (hash.length <= head + tail + 3) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}