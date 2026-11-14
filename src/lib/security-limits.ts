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

/** Old keys were the fixed word "primary" (or similar short words). */
export function isWeakStreamKey(key: string | null | undefined): boolean {
  return !key || key.length < 32;
}

// ---------- Browser security headers ----------
const FRAME_PARENTS =
  "'self' https://*.lovable.app https://*.lovable.dev https://lovable.dev https://*.lovableproject.com";

/**
 * Baseline headers for every page. Only /embed/* may be framed by other
 * sites; everything else (manage, meetings, sign-in) may only be framed by
 * us and the Lovable editor preview, which blocks click-jacking.
 */
export function securityHeadersFor(pathname: string): Record<string, string> {
  const embeddable = pathname.startsWith("/embed/");
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "content-security-policy": `frame-ancestors ${embeddable ? "*" : FRAME_PARENTS}; object-src 'none'; base-uri 'self'`,
    "permissions-policy": "geolocation=(), payment=(), usb=()",
  };
}
