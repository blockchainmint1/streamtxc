/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { clockLabel, parseChimeTranscript, recordingMinuteUsd, transcriptToText } from "./meeting-rules";

describe("recording & notes pricing (about 10x AWS cost)", () => {
  it("video recording is $0.165 per minute", () => {
    expect(recordingMinuteUsd(true, false)).toBe(0.165);
  });
  it("notes alone are $0.297 per minute (transcription + saving the sound)", () => {
    expect(recordingMinuteUsd(false, true)).toBe(0.297);
  });
  it("video + notes together are $0.425 per minute", () => {
    expect(recordingMinuteUsd(true, true)).toBe(0.425);
  });
  it("nothing on costs nothing", () => {
    expect(recordingMinuteUsd(false, false)).toBe(0);
  });
});

const T0 = Date.parse("2026-11-14T16:00:00Z");
function result(id: string, startOffset: number, partial: boolean, words: Array<[string, string]>) {
  return JSON.stringify({
    transcript: {
      results: [{
        resultId: id,
        isPartial: partial,
        startTimeMs: T0 + startOffset,
        endTimeMs: T0 + startOffset + 2000,
        alternatives: [{
          transcript: words.map((w) => w[1]).join(" "),
          items: words.map(([ext, content]) => ({ content, attendee: { attendeeId: "a", externalUserId: ext } })),
        }],
      }],
    },
  });
}

describe("who-said-what transcript", () => {
  const raw = [
    result("r1", 1000, true, [["habc12345|Alex", "Good"]]),
    result("r1", 1000, false, [["habc12345|Alex", "Good"], ["habc12345|Alex", "morning."]]),
    result("r2", 4000, false, [["habc12345|Alex", "Let's"], ["habc12345|Alex", "start."]]),
    result("r3", 9000, false, [["pzz998877|Maria", "Sales"], ["pzz998877|Maria", "are"], ["pzz998877|Maria", "up."]]),
    JSON.stringify({ transcriptionStatus: { type: "started" } }),
  ].join("\n");

  it("keeps only finished lines, credits each to the speaker, merges back-to-back lines", () => {
    const lines = parseChimeTranscript(raw, T0);
    expect(lines).toEqual([
      { atMs: 1000, speaker: "Alex", text: "Good morning. Let's start." },
      { atMs: 9000, speaker: "Maria", text: "Sales are up." },
    ]);
  });

  it("prints as [time] Name: words", () => {
    expect(transcriptToText(parseChimeTranscript(raw, T0))).toBe(
      "[0:01] Alex: Good morning. Let's start.\n[0:09] Maria: Sales are up.",
    );
  });

  it("handles pieces glued together without line breaks", () => {
    const glued = result("r9", 0, false, [["v12345678|Ana", "Hi."]]) + result("r10", 70_000, false, [["v12345678|Ana", "Bye."]]);
    expect(parseChimeTranscript(glued, T0).map((l) => l.text)).toEqual(["Hi.", "Bye."]);
  });

  it("formats long meetings with hours", () => {
    expect(clockLabel(3_725_000)).toBe("1:02:05");
  });
});
