// TXC pricing for video hosting.
// Quote in USD ($0.001/MB/month) → converted to TXC at the live spot price.

export const RATE_USD_PER_MB_PER_MONTH = 0.001; // USD
export const FALLBACK_TXC_USD = 0.10; // used only if the price feed is down
export const REWARD_CREDIT_PER_VIEW_USD = 0.0001; // USD equivalent
export const VIEW_DEBOUNCE_SECONDS = 30;
// 100 MB cap. Cloudflare Workers reject request bodies larger than ~100 MB,
// and we proxy uploads through our Worker → self-hosted IPFS to keep CORS
// allowlist off the critical path. Larger files? Pin to IPFS first
// and use the "Add by CID" flow.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// Cap for the S3-presigned-PUT path. The browser uploads
// directly to S3, bypassing the Cloudflare Worker body limit. S3's single
// PUT max is 5 GiB; we cap there.
export const MAX_S3_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const PAYMENT_GRACE_HOURS = 24 * 7; // unpaid videos are unpinned after this (1 week free)

/**
 * Dust threshold for incoming TXC. Platform-originated stamp outputs
 * (claim, renewal, takedown OP_RETURN dust) land at the video wallet
 * for ~0.0002–0.0003 TXC each. Anything below this is NOT a real user
 * payment — minimum hosting fee is 0.01 TXC and minimum comment is 0.01.
 */
export const PAYMENT_DUST_TXC = 0.001;

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

/** ISO date + 24h time in YYYY-MM-DD HH:MM:SS (local). */
export function formatDateTime(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}