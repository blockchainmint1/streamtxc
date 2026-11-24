import { describe, expect, test } from "bun:test";
import { decidePush, signBody, LIVE_HEARTBEAT_MS } from "./live-push-rules";

const base = { enabled: true, lastState: "off", lastStreamId: null, lastPushedAt: null, lastError: null };

describe("live push", () => {
  test("switched-off site is never told about a live stream", () => {
    expect(decidePush({ ...base, enabled: false }, "s1", 0)).toBeNull();
  });
  test("switched-on site is told when the stream starts", () => {
    expect(decidePush(base, "s1", 0)).toBe("live");
  });
  test("site is told the stream ended", () => {
    expect(decidePush({ ...base, lastState: "live", lastStreamId: "s1", lastPushedAt: 0 }, null, 1000)).toBe("ended");
  });
  test("switching a site off mid-stream ends it there", () => {
    expect(decidePush({ ...base, enabled: false, lastState: "live", lastStreamId: "s1", lastPushedAt: 0 }, "s1", 1000)).toBe("ended");
  });
  test("heartbeat every 5 minutes while live, not sooner", () => {
    const t = { ...base, lastState: "live", lastStreamId: "s1", lastPushedAt: 0 };
    expect(decidePush(t, "s1", LIVE_HEARTBEAT_MS - 1)).toBeNull();
    expect(decidePush(t, "s1", LIVE_HEARTBEAT_MS)).toBe("live");
  });
  test("signature matches HMAC-SHA256 of timestamp.body", async () => {
    const { createHmac } = await import("node:crypto");
    expect(await signBody("k", 1, "{}")).toBe(createHmac("sha256", "k").update("1.{}").digest("hex"));
    expect(await signBody("k", 1, "{}")).not.toBe(await signBody("k", 2, "{}"));
  });
});
