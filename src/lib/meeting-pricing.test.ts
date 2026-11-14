/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  PRICE_USD_PER_SEAT_MINUTE, PRICE_USD_PER_BROADCAST_MINUTE, isMeetingBillable, meetingMinuteUsd, shouldEndForCredit, usdToTxc8,
} from "./meeting-rules";
import { signLeaveToken, verifyLeaveToken } from "./meeting-leave";

describe("meeting pricing (10x AWS cost)", () => {
  it("one person for one minute costs $0.017", () => {
    expect(PRICE_USD_PER_SEAT_MINUTE).toBe(0.017);
  });
  it("a 10-person, 1-hour meeting costs $10.20", () => {
    expect(+(meetingMinuteUsd(10, false) * 60).toFixed(2)).toBe(10.2);
  });
  it("sending to the live stream adds $0.90 a minute", () => {
    expect(PRICE_USD_PER_BROADCAST_MINUTE).toBe(0.9);
    expect(meetingMinuteUsd(0, true)).toBe(0.9);
  });
  it("an empty room costs nothing", () => {
    expect(meetingMinuteUsd(0, false)).toBe(0);
  });
  it("converts to TXC at the spot price", () => {
    expect(usdToTxc8(0.17, 0.1)).toBe(1.7);
  });
  it("the admin room is never charged", () => {
    expect(isMeetingBillable("Tadmin", "Tadmin")).toBe(false);
    expect(isMeetingBillable("Tother", "Tadmin")).toBe(true);
  });
  it("closes the meeting when the host can't cover the next minute", () => {
    expect(shouldEndForCredit(1, 1.7)).toBe(true);
    expect(shouldEndForCredit(2, 1.7)).toBe(false);
  });
});

describe("leave tokens", () => {
  it("only the matching seat's token is accepted", async () => {
    const t = await signLeaveToken("s3cret", "m1", "a1");
    expect(await verifyLeaveToken("s3cret", "m1", "a1", t)).toBe(true);
    expect(await verifyLeaveToken("s3cret", "m1", "a2", t)).toBe(false);
    expect(await verifyLeaveToken("other", "m1", "a1", t)).toBe(false);
  });
});
