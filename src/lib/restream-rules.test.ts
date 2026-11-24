import { describe, expect, test } from "bun:test";
import { MAX_RESTREAM_DESTINATIONS, maskKey, validateServerUrl, withRestreamOutputs } from "./restream-rules";

const enc = {
  videoDescriptions: [{ name: "video_480p", height: 480 }, { name: "video_720p", height: 720 }],
  audioDescriptions: [{ name: "audio_aac" }],
  outputGroups: [{ name: "mediapackage" }, { name: "archive-to-s3-hls" }],
};
const dest = [{ id: "mediapackage-dest" }, { id: "s3-archive-dest" }];
const t = { serverUrl: "rtmp://a.rtmp.youtube.com/live2", streamKey: "abcd-1234" };

describe("restream rules", () => {
  test("adds one restream group and keeps the live + archive outputs", () => {
    const r = withRestreamOutputs(dest, enc, [t, t]);
    expect(r.encoderSettings.outputGroups.map((g: any) => g.name)).toEqual(["mediapackage", "archive-to-s3-hls", "restream"]);
    expect(r.destinations.map((d: any) => d.id)).toEqual(["mediapackage-dest", "s3-archive-dest", "restream-1", "restream-2"]);
    expect(r.encoderSettings.outputGroups[2].outputs[0].videoDescriptionName).toBe("video_720p");
  });
  test("re-applying replaces, and empty removes, our group only", () => {
    const once = withRestreamOutputs(dest, enc, [t, t]);
    const again = withRestreamOutputs(once.destinations, once.encoderSettings, [t]);
    expect(again.destinations.length).toBe(3);
    const off = withRestreamOutputs(again.destinations, again.encoderSettings, []);
    expect(off.destinations).toEqual(dest);
    expect(off.encoderSettings.outputGroups.length).toBe(2);
  });
  test("caps destinations at 10", () => {
    expect(MAX_RESTREAM_DESTINATIONS).toBe(10);
    expect(() => withRestreamOutputs(dest, enc, Array(11).fill(t))).toThrow();
  });
  test("only rtmp/rtmps server URLs are accepted", () => {
    expect(validateServerUrl("rtmps://live-api-s.facebook.com:443/rtmp/")).toBe("rtmps://live-api-s.facebook.com:443/rtmp");
    expect(() => validateServerUrl("https://evil.example/x")).toThrow();
    expect(() => validateServerUrl("rtmp://host")).toThrow();
  });
  test("keys are masked to the last 4 characters", () => {
    expect(maskKey("abcdefgh")).toBe("••••efgh");
  });
});
