/// <reference types="bun" />
import { expect, test } from "bun:test";
import { isPlausibleVideo, MIN_VIDEO_BYTES } from "./security-limits";

test("tiny probe files are rejected even with a video type", () => {
  expect(isPlausibleVideo(54, "video/mp4")).toBe(false);
  expect(isPlausibleVideo(MIN_VIDEO_BYTES - 1, "video/mp4")).toBe(false);
});

test("non-video types are rejected even when large", () => {
  expect(isPlausibleVideo(5_000_000, "text/html")).toBe(false);
  expect(isPlausibleVideo(5_000_000, "image/png")).toBe(false);
  expect(isPlausibleVideo(5_000_000, "text/plain; charset=utf-8")).toBe(false);
});

test("real videos are accepted", () => {
  expect(isPlausibleVideo(31_486_560, "video/mp4")).toBe(true);
  expect(isPlausibleVideo(MIN_VIDEO_BYTES, "video/quicktime")).toBe(true);
  expect(isPlausibleVideo(2_000_000, "application/octet-stream")).toBe(true);
});
