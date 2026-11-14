/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  MEETING_CODE_RE, capabilitiesFor, cleanDisplayName, decodeExternalUserId, encodeExternalUserId, newMeetingCode, roleForCode,
} from "./meeting-rules";

const room = { join_code: "JoinCode2345", view_code: "ViewCode2345", owner_wallet: "Thost" };

describe("meeting links", () => {
  it("view-only link gives a viewer seat, even for the host", () => {
    expect(roleForCode(room, "ViewCode2345", "Thost")).toBe("viewer");
  });
  it("team link gives the host seat only to the signed-in owner", () => {
    expect(roleForCode(room, "JoinCode2345", "Thost")).toBe("host");
    expect(roleForCode(room, "JoinCode2345", "Tsomeone")).toBe("participant");
    expect(roleForCode(room, "JoinCode2345", null)).toBe("participant");
  });
  it("unknown codes get no seat", () => {
    expect(roleForCode(room, "Nope00000000", null)).toBeNull();
  });
  it("viewers can never send mic, camera or screen", () => {
    expect(capabilitiesFor("viewer")).toEqual({ Audio: "Receive", Video: "Receive", Content: "Receive" });
    expect(capabilitiesFor("participant").Audio).toBe("SendReceive");
  });
  it("codes are 12 random characters", () => {
    const a = newMeetingCode();
    expect(a).toMatch(MEETING_CODE_RE);
    expect(newMeetingCode()).not.toBe(a);
  });
  it("names round-trip and fit AWS's 64-character limit", () => {
    const ext = encodeExternalUserId("viewer", "Bobby <script>", "abcdef1234567890");
    expect(ext.length).toBeLessThanOrEqual(64);
    expect(decodeExternalUserId(ext)).toEqual({ role: "viewer", name: "Bobby script" });
    expect(cleanDisplayName("   ")).toBe("Guest");
  });
});
