/**
 * Shared constants + pure helpers for the QR wallet sign-in flow.
 * Safe for both client and server bundles (no node-only imports).
 *
 * Flow (mirrors payHME / NectarPay so the same HME Wallet build works here):
 *   1. Browser POSTs /api/public/auth/wallet-challenge  → { id, nonce, qr_data, deep_link }
 *   2. Browser renders `qr_data` as a QR code.
 *   3. HME Wallet scans it, signs the message, POSTs address+signature to
 *      the `callback` URL inside the envelope.
 *   4. Browser polls /api/public/auth/wallet-status?id=… until `signed`,
 *      then POSTs the one-time token to /api/public/auth/wallet-exchange
 *      which returns a normal streamTXC wallet session token.
 */

export const WALLET_DEEP_LINK_SCHEME = "payhme";
export const WALLET_CHALLENGE_TTL_SECONDS = 300;
export const WALLET_POLL_INTERVAL_MS = 2000;

/** Canonical public home for streamTXC — used when the request host is local. */
const WALLET_AUTH_PUBLIC_ORIGIN = "https://streamtxc.com";

/** Human-readable, SIWE-flavored message the wallet displays and signs verbatim. */
export function buildSignableMessage(opts: {
  nonce: string;
  domain: string;
  issuedAt: string;
}): string {
  return [
    `${opts.domain} wants you to sign in with your TXC wallet.`,
    ``,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
    `By signing, you authorize a sign-in session for streamTXC.`,
    `This signature does not authorize any payment.`,
  ].join("\n");
}

/** base64url (no padding) — works in browser and worker runtimes. */
export function base64UrlEncode(input: string): string {
  const b64 =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(input)))
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(input, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign-in always names the canonical site; no caller headers or query can change it. */
export function publicOriginFromRequest(_request: Request): string {
  return WALLET_AUTH_PUBLIC_ORIGIN;
}

export function authDomainFromRequest(_request: Request): string {
  return new URL(WALLET_AUTH_PUBLIC_ORIGIN).hostname;
}

export function matchesSignableMessage(message: string | undefined, expected: string): boolean {
  return message === undefined || message.replace(/\r\n/g, "\n") === expected;
}

export function buildWalletCallbackUrl(opts: {
  challengeId: string;
  origin: string;
}): string {
  const originUrl = new URL(opts.origin);
  const cbUrl = new URL("/api/public/auth/wallet-callback", originUrl);
  cbUrl.searchParams.set("id", opts.challengeId);
  return cbUrl.toString();
}

/** `payhme://login?…` deep link — used by the "open wallet" button on mobile. */
export function buildDeepLink(opts: {
  challengeId: string;
  nonce: string;
  origin: string;
  message: string;
}): string {
  const originUrl = new URL(opts.origin);
  const params = new URLSearchParams({
    id: opts.challengeId,
    nonce: opts.nonce,
    cb: buildWalletCallbackUrl({
      challengeId: opts.challengeId,
      origin: opts.origin,
    }),
    msg: base64UrlEncode(opts.message),
    from: originUrl.hostname,
  });
  return `${WALLET_DEEP_LINK_SCHEME}://login?${params.toString()}`;
}

/** JSON envelope encoded into the QR code — the HME Wallet's native format. */
export function buildWalletLoginEnvelope(opts: {
  challengeId: string;
  nonce: string;
  origin: string;
  expiresAt: string;
}): string {
  const originUrl = new URL(opts.origin);
  return JSON.stringify({
    v: 1,
    type: "hm-login",
    origin: originUrl.hostname,
    nonce: opts.nonce,
    callback: buildWalletCallbackUrl({
      challengeId: opts.challengeId,
      origin: opts.origin,
    }),
    statement: "This signature does not authorize any payment.",
    expiresAt: new Date(opts.expiresAt).getTime(),
    chain: "txc",
  });
}
