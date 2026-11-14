/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { cleanRoomTitle, needsApproval } from "./meeting-rules";

describe("waiting room approval", () => {
  const room = { approve_team: true, approve_viewers: false };
  it("team-link people wait when the host approves the team link", () => {
    expect(needsApproval(room, "participant")).toBe(true);
  });
  it("view-only people walk in when only the team link needs approval", () => {
    expect(needsApproval(room, "viewer")).toBe(false);
  });
  it("view-only people wait when the host approves the view-only link", () => {
    expect(needsApproval({ approve_team: false, approve_viewers: true }, "viewer")).toBe(true);
  });
  it("the host never waits", () => {
    expect(needsApproval({ approve_team: true, approve_viewers: true }, "host")).toBe(false);
  });
  it("auto-approve lets everyone in", () => {
    expect(needsApproval({ approve_team: false, approve_viewers: false }, "participant")).toBe(false);
  });
});

describe("room names", () => {
  it("keeps names like 'Weekly Sales Meeting' and trims extra spaces", () => {
    expect(cleanRoomTitle("  Weekly   Sales Meeting ")).toBe("Weekly Sales Meeting");
  });
  it("caps names at 80 characters", () => {
    expect(cleanRoomTitle("x".repeat(200)).length).toBe(80);
  });
});
