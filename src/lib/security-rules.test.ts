/// <reference types="bun" />
import { expect, test } from "bun:test";
import { transcodeAllowed, FRESH_UPLOAD_WINDOW_MS } from "./transcode-guard";

const OWNER = "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m";
const OTHER = "TgCKcnxHJiLrBgDXHNx8jM4FBuNK7k63Jd";
const now = Date.now();
const row = (o: Partial<Parameters<typeof transcodeAllowed>[0] & object> = {}) => ({
  owner_wallet: OWNER,
  hls_cid: "bafyexistinghls",
  transcode_status: "complete",
  created_at: new Date(now - 30 * 864e5).toISOString(),
  ...o,
});

test("a stranger cannot replace an existing owned video's playback", () => {
  expect(transcodeAllowed(row(), OTHER, now).ok).toBe(false);
  expect(transcodeAllowed(row(), null, now).ok).toBe(false);
});

test("the owner can re-convert their own video", () => {
  expect(transcodeAllowed(row(), OWNER, now).ok).toBe(true);
});

test("an unowned video that was already converted is locked", () => {
  expect(transcodeAllowed(row({ owner_wallet: null }), null, now).ok).toBe(false);
});

test("anonymous fresh upload still works, but only within the window", () => {
  const fresh = row({ owner_wallet: null, hls_cid: null, transcode_status: null, created_at: new Date(now).toISOString() });
  expect(transcodeAllowed(fresh, null, now).ok).toBe(true);
  expect(transcodeAllowed(fresh, null, now + FRESH_UPLOAD_WINDOW_MS + 1).ok).toBe(false);
  expect(transcodeAllowed(null, null, now).ok).toBe(true);
});

// ---- Audit M-1/M-3/M-5/M-7/M-10 ----
import { isDropboxDirectUrl, emailSendDecision, EMAIL_DAILY_MAX, newStreamKey, isWeakStreamKey, securityHeadersFor, escapeHtml, isLovableHost } from "./security-limits";
import { readSessionClaims, issueWalletBrowserProof } from "./wallet-auth.server";

test("Dropbox shortcut imports only accept Dropbox's own https download hosts", () => {
  expect(isDropboxDirectUrl("https://dl.dropboxusercontent.com/1/view/abc/video.mp4")).toBe(true);
  expect(isDropboxDirectUrl("https://evil.example/video.mp4")).toBe(false);
  expect(isDropboxDirectUrl("https://dl.dropboxusercontent.com.evil.example/x")).toBe(false);
  expect(isDropboxDirectUrl("http://dl.dropboxusercontent.com/x")).toBe(false);
  expect(isDropboxDirectUrl("https://user:pw@dl.dropboxusercontent.com/x")).toBe(false);
  expect(isDropboxDirectUrl("not a url")).toBe(false);
});

test("verification emails: one per minute per wallet", () => {
  const t0 = Date.parse("2026-11-14T12:00:00Z");
  const first = emailSendDecision({ lastSentAt: null, windowStart: null, count: 0 }, t0);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(emailSendDecision(first.next, t0 + 30_000).ok).toBe(false);
  expect(emailSendDecision(first.next, t0 + 61_000).ok).toBe(true);
});

test("verification emails: at most five a day, then the count resets", () => {
  const t0 = Date.parse("2026-11-14T12:00:00Z");
  let state = { lastSentAt: null as string | null, windowStart: null as string | null, count: 0 };
  for (let i = 0; i < EMAIL_DAILY_MAX; i++) {
    const d = emailSendDecision(state, t0 + i * 120_000);
    expect(d.ok).toBe(true);
    if (d.ok) state = d.next;
  }
  expect(EMAIL_DAILY_MAX).toBe(5);
  expect(emailSendDecision(state, t0 + 3600_000).ok).toBe(false);
  expect(emailSendDecision(state, t0 + 24 * 3600_000 + 1000).ok).toBe(true);
});

test("new stream keys are 64 random hex characters; the old word keys are flagged", () => {
  const a = newStreamKey();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(newStreamKey()).not.toBe(a);
  expect(isWeakStreamKey("primary")).toBe(true);
  expect(isWeakStreamKey(a)).toBe(false);
});

test("only /embed pages may be framed by other sites", () => {
  expect(securityHeadersFor("/manage")["content-security-policy"]).not.toContain("frame-ancestors *");
  expect(securityHeadersFor("/meet/abc")["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(securityHeadersFor("/embed/bafy123")["content-security-policy"]).toContain("frame-ancestors *");
  expect(securityHeadersFor("/")["x-content-type-options"]).toBe("nosniff");
});

test("only Lovable's own preview hosts may frame the app; custom domains frame nothing but themselves", () => {
  expect(securityHeadersFor("/manage", "streamtxc.com")["content-security-policy"]).toContain("frame-ancestors 'self';");
  expect(securityHeadersFor("/manage", "streamtxc.com")["content-security-policy"]).not.toContain("lovable");
  expect(securityHeadersFor("/manage", "id-preview--x.lovable.app")["content-security-policy"]).toContain("https://*.lovable.app");
  expect(isLovableHost("streamtxc.com.lovable.app.evil.com")).toBe(false);
});

test("HSTS covers subdomains, and embeds on other sites never get camera or mic", () => {
  expect(securityHeadersFor("/", "streamtxc.com")["strict-transport-security"]).toContain("includeSubDomains");
  expect(securityHeadersFor("/embed/bafy", "streamtxc.com")["permissions-policy"]).toContain("camera=()");
  expect(securityHeadersFor("/embed/bafy", "streamtxc.com")["permissions-policy"]).toContain("microphone=()");
  expect(securityHeadersFor("/meet/abc", "streamtxc.com")["permissions-policy"]).toContain("camera=(self)");
});

test("emails shown on the verify page are escaped", () => {
  expect(escapeHtml('<img src=x onerror="a">')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;");
});

test("old-style or wrong-kind tokens are not accepted as sign-ins", async () => {
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-only-session-secret";
  try {
    const proof = await issueWalletBrowserProof("x", new Date(Date.now() + 60_000).toISOString());
    expect(await readSessionClaims(proof)).toBeNull();
    expect(await readSessionClaims("garbage.token")).toBeNull();
  } finally {
    if (prev === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prev;
  }
});
