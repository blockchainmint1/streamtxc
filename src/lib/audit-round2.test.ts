/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  seatIsLive, seatIsAbandoned, seatHoldsPlace, mayOpenRoom, mayAutoStartRecording, hostAbsentTooLong,
  shouldEndForLiveReserve, clampMaxSeats, cleanPublishText, PUBLISH_DESCRIPTION_MAX, LIVE_RESERVE_MINUTES,
} from "./meeting-rules";
import { leaveSecret, signLeaveToken, verifyLeaveToken } from "./meeting-leave";
import { secretMatches } from "./admin-token";
import { keyedIpHash } from "./ip-hash";
import { mediaResponseHeaders } from "./media-security";

const now = Date.parse("2026-11-15T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("N-1: hosts pay only for seats that are really connected", () => {
  it("a seat that never checked in is not billed", () => {
    expect(seatIsLive({ created_at: ago(10_000), last_seen_at: null, left_at: null }, now)).toBe(false);
  });
  it("a seat that checked in within 3 minutes is billed", () => {
    expect(seatIsLive({ created_at: ago(600_000), last_seen_at: ago(170_000), left_at: null }, now)).toBe(true);
  });
  it("a seat quiet for over 3 minutes is not billed and gets removed", () => {
    const s = { created_at: ago(600_000), last_seen_at: ago(190_000), left_at: null };
    expect(seatIsLive(s, now)).toBe(false);
    expect(seatIsAbandoned(s, now)).toBe(true);
  });
  it("a seat that never connected is removed after 2 minutes, not before", () => {
    expect(seatIsAbandoned({ created_at: ago(119_000), last_seen_at: null, left_at: null }, now)).toBe(false);
    expect(seatIsAbandoned({ created_at: ago(121_000), last_seen_at: null, left_at: null }, now)).toBe(true);
  });
  it("brand-new seats still connecting count toward the room's limit", () => {
    expect(seatHoldsPlace({ created_at: ago(5_000), last_seen_at: null, left_at: null }, now)).toBe(true);
    expect(seatHoldsPlace({ created_at: ago(5_000), last_seen_at: null, left_at: ago(1_000) }, now)).toBe(false);
  });
  it("seat limit stays between 2 and 250", () => {
    expect(clampMaxSeats(1)).toBe(2);
    expect(clampMaxSeats(999)).toBe(250);
    expect(clampMaxSeats(25)).toBe(25);
  });
  it("a meeting closes before it eats the last 30 minutes of a running live stream", () => {
    expect(LIVE_RESERVE_MINUTES).toBe(30);
    expect(shouldEndForLiveReserve(29, true, 1)).toBe(true);
    expect(shouldEndForLiveReserve(31, true, 1)).toBe(false);
    expect(shouldEndForLiveReserve(1, false, 1)).toBe(false);
  });
});

describe("N-2: only the host opens a room unless they allow the team", () => {
  it("view-only watchers can never open a room", () => {
    expect(mayOpenRoom("viewer", true)).toBe(false);
  });
  it("team link opens the room only when 'team can start without me' is on", () => {
    expect(mayOpenRoom("participant", false)).toBe(false);
    expect(mayOpenRoom("participant", true)).toBe(true);
    expect(mayOpenRoom("host", false)).toBe(true);
  });
  it("automatic recording starts only with the host (or a team the host allowed)", () => {
    expect(mayAutoStartRecording("participant", false)).toBe(false);
    expect(mayAutoStartRecording("viewer", true)).toBe(false);
    expect(mayAutoStartRecording("host", false)).toBe(true);
  });
  it("room closes after the host has been gone 10 minutes", () => {
    const base = { teamCanStart: false, meetingOpenedMs: now - 3_600_000, nowMs: now };
    expect(hostAbsentTooLong({ ...base, hostLastSeenMs: now - 9 * 60_000 })).toBe(false);
    expect(hostAbsentTooLong({ ...base, hostLastSeenMs: now - 11 * 60_000 })).toBe(true);
    expect(hostAbsentTooLong({ ...base, hostLastSeenMs: null })).toBe(true);
    expect(hostAbsentTooLong({ ...base, teamCanStart: true, hostLastSeenMs: null })).toBe(false);
  });
});

describe("N-3: seat tokens never silently switch off", () => {
  it("fails closed with no key at all", async () => {
    await expect(leaveSecret({})).rejects.toThrow();
  });
  it("falls back to a key derived from the session secret (not the secret itself)", async () => {
    const k = await leaveSecret({ SESSION_SECRET: "s3cret" });
    expect(k).not.toBe("s3cret");
    expect(k).toHaveLength(64);
  });
  it("a seat token only works for its own seat", async () => {
    const t = await signLeaveToken("k", "meet-1234", "att-12345");
    expect(await verifyLeaveToken("k", "meet-1234", "att-12345", t)).toBe(true);
    expect(await verifyLeaveToken("k", "meet-1234", "att-99999", t)).toBe(false);
  });
});

describe("N-4: published description is capped", () => {
  it("cuts the description at 2000 characters", () => {
    expect(cleanPublishText("x".repeat(5000), PUBLISH_DESCRIPTION_MAX)).toHaveLength(2000);
  });
});

describe("H-6: admin password check", () => {
  it("matches only the exact password", () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abd", "abc")).toBe(false);
    expect(secretMatches("abc", "abcd")).toBe(false);
    expect(secretMatches(null, "abc")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});

describe("N-8 / N-9", () => {
  it("IP hashes depend on a server secret, and report/view hashes differ", async () => {
    const a = await keyedIpHash("report", "1.2.3.4", "k1");
    expect(a).not.toBe(await keyedIpHash("report", "1.2.3.4", "k2"));
    expect(a).not.toBe(await keyedIpHash("view", "1.2.3.4", "k1"));
  });
  it("user SVG files download instead of opening on our site", () => {
    const h = mediaResponseHeaders("image/svg+xml");
    expect(h.get("content-disposition")).toBe("attachment");
    expect(h.get("content-type")).toBe("application/octet-stream");
  });
});
