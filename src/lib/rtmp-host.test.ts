/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { prettifyRtmpUrl } from "./rtmp-host";

describe("prettifyRtmpUrl", () => {
  it("uses live.streamtxc.com when it points at the channel's IP", () => {
    expect(prettifyRtmpUrl("rtmp://203.0.113.10:1935/live", ["203.0.113.10"])).toBe("rtmp://live.streamtxc.com:1935/live");
  });
  it("keeps the raw IP when the name points elsewhere", () => {
    expect(prettifyRtmpUrl("rtmp://198.51.100.20:1935/w-x", ["203.0.113.10"])).toBe("rtmp://198.51.100.20:1935/w-x");
  });
  it("never rewrites secure rtmps addresses", () => {
    expect(prettifyRtmpUrl("rtmps://203.0.113.10:443/live", ["203.0.113.10"])).toBe("rtmps://203.0.113.10:443/live");
  });
});
