import { describe, expect, test } from "bun:test";
import { guestSpot, parseStudioSignal } from "./green-room";

describe("green room", () => {
  test("guest not on stage waits backstage while on air", () => {
    expect(guestSpot({ onAir: true, stage: ["b"] }, "a", false)).toBe("backstage");
  });
  test("guest on stage is live", () => {
    expect(guestSpot({ onAir: true, stage: ["a"] }, "a", false)).toBe("on-stage");
  });
  test("nobody is held backstage when the studio is off air", () => {
    expect(guestSpot({ onAir: false, stage: [] }, "a", false)).toBe("meeting");
  });
  test("host is never held backstage", () => {
    expect(guestSpot({ onAir: true, stage: [] }, "h", true)).toBe("meeting");
  });
  test("bad messages are ignored", () => {
    expect(parseStudioSignal("{nope")).toBeNull();
    expect(parseStudioSignal(JSON.stringify({ onAir: "yes", stage: [] }))).toBeNull();
  });
});

import { isHostSender } from "./green-room";
import { seatCapabilities } from "./meeting-rules";
describe("studio enforcement", () => {
  test("only the host may send studio signals", () => {
    expect(isHostSender("habc12345|Host")).toBe(true);
    expect(isHostSender("pabc12345|Guest")).toBe(false);
    expect(isHostSender(undefined)).toBe(false);
  });
  test("backstage guests are receive-only while on air", () => {
    expect(seatCapabilities("participant", true, false)).toEqual({ Audio: "Receive", Video: "Receive", Content: "Receive" });
    expect(seatCapabilities("participant", true, true).Audio).toBe("SendReceive");
    expect(seatCapabilities("participant", false, false).Audio).toBe("SendReceive");
    expect(seatCapabilities("host", true, false).Audio).toBe("SendReceive");
  });
});
