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
