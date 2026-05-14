// TXC pricing for video hosting.
// Quote in USD ($0.001/MB/month) → converted to TXC at the live spot price.

export const RATE_USD_PER_MB_PER_MONTH = 0.001; // USD
export const FALLBACK_TXC_USD = 0.10; // used only if the price feed is down
export const REWARD_CREDIT_PER_VIEW_USD = 0.0001; // USD equivalent
export const VIEW_DEBOUNCE_SECONDS = 30;
// 100 MB cap. Cloudflare Workers reject request bodies larger than ~100 MB,
// and we proxy uploads through our Worker → Pinata to keep Pinata's CORS
// allowlist off the critical path. Larger files? Pin to IPFS first
// (e.g. pinata.cloud) and use the "Add by CID" flow.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const PAYMENT_GRACE_HOURS = 24 * 7; // unpaid videos are unpinned after this (1 week free)

/** Quote in USD — pure, no network. */
export function quoteUsd(sizeBytes: number, months = 1): number {
  const sizeMB = sizeBytes / (1024 * 1024);
  return +(sizeMB * RATE_USD_PER_MB_PER_MONTH * months).toFixed(4);
}

/** Convert a USD quote to TXC at a given spot price. */
export function usdToTxc(usd: number, txcUsd: number): number {
  const safe = txcUsd > 0 ? txcUsd : FALLBACK_TXC_USD;
  return Math.max(0.0001, +(usd / safe).toFixed(4));
}

/**
 * Convenience client-side quote when a price is already known.
 * Server callers should use `quoteFeeWithLivePrice` from fees.server.ts.
 */
export function quoteFee(sizeBytes: number, months = 1, txcUsd = FALLBACK_TXC_USD): number {
  return usdToTxc(quoteUsd(sizeBytes, months), txcUsd);
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

/** ISO calendar date in YYYY-MM-DD (local time). Standard format across the app. */
export function formatDate(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}