import { describe, expect, it } from "vitest";
import { prettifyRtmpUrl } from "./rtmp-host";

describe("prettifyRtmpUrl", () => {
  it("uses live.streamtxc.com when it points at the channel's IP", () => {
    expect(prettifyRtmpUrl("rtmp://52.45.63.166:1935/live", ["52.45.63.166"])).toBe("rtmp://live.streamtxc.com:1935/live");
  });
  it("keeps the raw IP when the name points elsewhere", () => {
    expect(prettifyRtmpUrl("rtmp://52.1.53.89:1935/w-x", ["52.45.63.166"])).toBe("rtmp://52.1.53.89:1935/w-x");
  });
  it("never rewrites secure rtmps addresses", () => {
    expect(prettifyRtmpUrl("rtmps://52.45.63.166:443/live", ["52.45.63.166"])).toBe("rtmps://52.45.63.166:443/live");
  });
});
