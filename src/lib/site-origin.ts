/**
 * Canonical public origin for share links and embed codes.
 *
 * Never use window.location.origin for anything a user copies out of the app:
 * inside the Lovable preview that resolves to a *.lovable.app host, which then
 * gets pasted into other sites and 302s through an extra hop (or breaks
 * entirely once the preview build rotates).
 */
export const SITE_ORIGIN = "https://streamtxc.com";

/** Hosts that are legitimate public homes for this app. */
const PUBLIC_HOSTS = [
  "streamtxc.com",
  "www.streamtxc.com",
  "stream.texitcoin.org",
];

/**
 * Origin to use in copyable links. Keeps the user's own custom domain when
 * they're browsing one, otherwise falls back to the canonical domain.
 */
export function publicOrigin(): string {
  if (typeof window === "undefined") return SITE_ORIGIN;
  const host = window.location.hostname;
  if (PUBLIC_HOSTS.includes(host)) return window.location.origin;
  return SITE_ORIGIN;
}
