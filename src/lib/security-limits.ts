// Small, pure security rules shared by server code and tests.

/** Dropbox Chooser direct links may only come from Dropbox's own download hosts. */
export function isDropboxDirectUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return (
    h === "dl.dropboxusercontent.com" ||
    h.endsWith(".dl.dropboxusercontent.com") ||
    h === "dropbox.com" ||
    h === "www.dropbox.com" ||
    h === "dl.dropbox.com"
  );
}

// ---------- Verification-email limits ----------
export const EMAIL_RESEND_GAP_SEC = 60;
export const EMAIL_DAILY_MAX = 5;

export interface EmailSendState {
  lastSentAt: string | null;
  windowStart: string | null;
  count: number;
}

/** At most one verification email a minute and five a day per wallet. */
export function emailSendDecision(
  s: EmailSendState,
  nowMs: number,
): { ok: true; next: EmailSendState } | { ok: false; retryInSec: number } {
  const last = s.lastSentAt ? new Date(s.lastSentAt).getTime() : 0;
  const gap = Math.ceil((last + EMAIL_RESEND_GAP_SEC * 1000 - nowMs) / 1000);
  if (gap > 0) return { ok: false, retryInSec: gap };
  const winStart = s.windowStart ? new Date(s.windowStart).getTime() : 0;
  const inWindow = nowMs - winStart < 24 * 3600_000;
  const count = inWindow ? s.count : 0;
  if (count >= EMAIL_DAILY_MAX) {
    return { ok: false, retryInSec: Math.ceil((winStart + 24 * 3600_000 - nowMs) / 1000) };
  }
  const nowIso = new Date(nowMs).toISOString();
  return {
    ok: true,
    next: { lastSentAt: nowIso, windowStart: inWindow ? s.windowStart : nowIso, count: count + 1 },
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Live stream keys ----------
/** 32 random bytes as hex — unguessable, URL/RTMP safe. */
export function newStreamKey(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Anything shorter than a generated key is treated as weak and flagged for rotation. */
export function isWeakStreamKey(key: string | null | undefined): boolean {
  return !key || key.length < 32;
}

// ---------- Browser security headers ----------
const LOVABLE_FRAME_PARENTS = "https://*.lovable.app https://*.lovable.dev https://lovable.dev https://*.lovableproject.com";

/** Lovable's own preview/published hosts (the editor frames these); custom domains are never framed by Lovable. */
export function isLovableHost(host: string | null | undefined): boolean {
  const h = (host ?? "").toLowerCase().split(":")[0];
  return h === "localhost" || h.endsWith(".lovable.app") || h.endsWith(".lovableproject.com") || h.endsWith(".lovable.dev");
}

/**
 * Baseline headers for every page. Only /embed/* may be framed by other
 * sites; everything else (manage, meetings, sign-in) may only be framed by
 * us — plus the Lovable editor when served from a Lovable preview host —
 * which blocks click-jacking. Camera, microphone and screen capture are
 * never available to other sites' frames or to embeds.
 */
export function securityHeadersFor(pathname: string, host?: string | null): Record<string, string> {
  const embeddable = pathname.startsWith("/embed/");
  const parents = isLovableHost(host) ? `'self' ${LOVABLE_FRAME_PARENTS}` : "'self'";
  // In-app navigation keeps the first page's policy, so the whole site keeps
  // camera/mic for itself (meetings) while every other site's frames get none;
  // embeds on other sites never get them.
  const media = embeddable ? "camera=(), microphone=(), display-capture=()" : "camera=(self), microphone=(self), display-capture=(self)";
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "content-security-policy": `frame-ancestors ${embeddable ? "*" : parents}; object-src 'none'; base-uri 'self'`,
    "permissions-policy": `geolocation=(), payment=(), usb=(), ${media}`,
  };
}
