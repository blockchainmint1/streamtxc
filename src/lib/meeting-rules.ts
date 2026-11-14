// Pure rules for /meet rooms — shared by server functions, the client and tests.

export type MeetingRole = "host" | "participant" | "viewer";

/** Link codes: 12 base62 chars from crypto randomness (~71 bits, unguessable). */
export const MEETING_CODE_RE = /^[A-Za-z0-9]{12}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function newMeetingCode(): string {
  const out: string[] = [];
  const buf = new Uint8Array(32);
  while (out.length < 12) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // Reject-sample so every character is equally likely.
      if (b < 256 - (256 % ALPHABET.length)) out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === 12) break;
    }
  }
  return out.join("");
}

/** Which seat a link code gives. Participant and view-only codes never overlap. */
export function roleForCode(
  room: { join_code: string; view_code: string; owner_wallet: string },
  code: string,
  wallet: string | null,
): MeetingRole | null {
  if (code === room.view_code) return "viewer";
  if (code === room.join_code) return wallet && wallet === room.owner_wallet ? "host" : "participant";
  return null;
}

/** View-only seats can only receive; they can never send mic, camera or screen. */
export function capabilitiesFor(role: MeetingRole) {
  if (role === "viewer") return { Audio: "Receive", Video: "Receive", Content: "Receive" } as const;
  return { Audio: "SendReceive", Video: "SendReceive", Content: "SendReceive" } as const;
}

export function cleanDisplayName(raw: string): string {
  const s = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} .'_-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return s.length >= 1 ? s : "Guest";
}

const ROLE_PREFIX: Record<MeetingRole, string> = { host: "h", participant: "p", viewer: "v" };

/** Chime ExternalUserId (2–64 chars): `<role><random>|<name>`. */
export function encodeExternalUserId(role: MeetingRole, name: string, rand: string): string {
  return `${ROLE_PREFIX[role]}${rand.slice(0, 8)}|${cleanDisplayName(name)}`.slice(0, 64);
}

export function decodeExternalUserId(ext: string | null | undefined): { role: MeetingRole; name: string } {
  const s = String(ext ?? "");
  const bar = s.indexOf("|");
  const prefix = s.charAt(0);
  const role: MeetingRole = prefix === "h" ? "host" : prefix === "v" ? "viewer" : "participant";
  return { role, name: bar >= 0 ? s.slice(bar + 1) || "Guest" : "Guest" };
}

// ---------- Pricing (about 10x our AWS cost) ----------
// AWS Chime SDK: $0.0017 per connected seat per minute (view-only seats count too).
// Live connector ("Send to live stream"): $0.09 per minute.
export const AWS_USD_PER_SEAT_MINUTE = 0.0017;
export const AWS_USD_PER_BROADCAST_MINUTE = 0.09;
export const MEETING_MARKUP = 10;
export const PRICE_USD_PER_SEAT_MINUTE = +(AWS_USD_PER_SEAT_MINUTE * MEETING_MARKUP).toFixed(6);
export const PRICE_USD_PER_BROADCAST_MINUTE = +(AWS_USD_PER_BROADCAST_MINUTE * MEETING_MARKUP).toFixed(6);
/** A host needs enough balance for 2 people × 5 minutes before a paid room opens. */
export const MIN_START_SEAT_MINUTES = 10;

/** What one minute of a meeting costs the host, in USD. */
export function meetingMinuteUsd(seats: number, broadcasting: boolean): number {
  const n = Math.max(0, Math.floor(seats));
  return +(n * PRICE_USD_PER_SEAT_MINUTE + (broadcasting ? PRICE_USD_PER_BROADCAST_MINUTE : 0)).toFixed(6);
}

/** USD → TXC at a spot price, rounded to 8 decimals (TXC's smallest unit). */
export function usdToTxc8(usd: number, txcUsd: number): number {
  if (!(txcUsd > 0) || usd <= 0) return 0;
  return +(usd / txcUsd).toFixed(8);
}

/** Bobby's own team room is paid by the company, never charged. */
export function isMeetingBillable(ownerWallet: string, adminWallet: string): boolean {
  return ownerWallet !== adminWallet;
}

/** After charging a minute, should the meeting close because the host can't cover the next one? */
export function shouldEndForCredit(balanceTxc: number, nextMinuteTxc: number): boolean {
  return nextMinuteTxc > 0 && balanceTxc < nextMinuteTxc;
}

// ---------- Room settings & waiting room ----------
export const MAX_ROOMS_PER_HOST = 20;
/** A waiting guest whose page hasn't checked in for this long has given up. */
export const WAITING_STALE_MS = 30_000;

/** Does this seat have to wait for the host to let them in? The host never waits. */
export function needsApproval(
  room: { approve_team: boolean; approve_viewers: boolean },
  role: MeetingRole,
): boolean {
  if (role === "host") return false;
  return role === "viewer" ? room.approve_viewers : room.approve_team;
}

export function cleanRoomTitle(raw: string): string {
  return raw.normalize("NFKC").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

// ---------- Recording & meeting notes (about 10x our AWS cost) ----------
// Video: 1080p composited capture $0.0125/min + joining the 5-second pieces
// into one file (video + audio, $0.002/min each).
export const AWS_USD_PER_VIDEO_RECORD_MINUTE = 0.0165;
// Notes: Amazon Transcribe live $0.024/min + joining the transcript pieces $0.002/min.
export const AWS_USD_PER_NOTES_MINUTE = 0.026;
// Notes without video still need the meeting's sound captured: $0.0017 + $0.002 to join.
export const AWS_USD_PER_AUDIO_CAPTURE_MINUTE = 0.0037;
/** Private recordings are kept this long; the transcript and notes are kept forever. */
export const RECORDING_KEEP_DAYS = 90;

/** What one minute of recording and/or notes costs the host, in USD. */
export function recordingMinuteUsd(video: boolean, notes: boolean): number {
  let aws = 0;
  if (video) aws += AWS_USD_PER_VIDEO_RECORD_MINUTE;
  if (notes) aws += AWS_USD_PER_NOTES_MINUTE;
  if (notes && !video) aws += AWS_USD_PER_AUDIO_CAPTURE_MINUTE;
  return +(aws * MEETING_MARKUP).toFixed(6);
}

export interface TranscriptLine {
  /** Milliseconds from the start of the recording. */
  atMs: number;
  speaker: string;
  text: string;
}

function pick(o: any, ...keys: string[]): any {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** Splits the joined transcript file into JSON objects (one per line, or glued together). */
function transcriptObjects(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      for (const part of s.replace(/}\s*{/g, "}\n{").split("\n")) {
        try { out.push(JSON.parse(part)); } catch { /* skip a damaged piece */ }
      }
    }
  }
  return out;
}

/**
 * Turns Amazon's live-transcription file into "who said what" lines.
 * Only final (not partial) results count; each result is credited to whoever
 * spoke most of its words, and back-to-back lines by the same person are merged.
 */
export function parseChimeTranscript(raw: string, recordingStartMs: number): TranscriptLine[] {
  const finals = new Map<string, { start: number; speaker: string; text: string }>();
  for (const obj of transcriptObjects(raw)) {
    const t = pick(obj, "transcript", "Transcript");
    const results: any[] = pick(t, "results", "Results") ?? [];
    for (const r of results) {
      if (pick(r, "isPartial", "IsPartial") !== false) continue;
      const alt = (pick(r, "alternatives", "Alternatives") ?? [])[0];
      const text = String(pick(alt, "transcript", "Transcript") ?? "").trim();
      if (!text) continue;
      const votes = new Map<string, number>();
      for (const it of pick(alt, "items", "Items") ?? []) {
        const att = pick(it, "attendee", "Attendee") ?? {};
        const ext = pick(att, "externalUserId", "ExternalUserId") ?? pick(it, "speakerExternalUserId", "SpeakerExternalUserId");
        if (!ext) continue;
        const name = decodeExternalUserId(ext).name;
        votes.set(name, (votes.get(name) ?? 0) + 1);
      }
      const speaker = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Someone";
      const start = Number(pick(r, "startTimeMs", "StartTimeMs", "startTime", "StartTime") ?? 0);
      const id = String(pick(r, "resultId", "ResultId") ?? `${start}-${text.slice(0, 20)}`);
      finals.set(id, { start, speaker, text });
    }
  }
  const sorted = [...finals.values()].sort((a, b) => a.start - b.start);
  // Amazon's times are wall-clock milliseconds → measure from when recording began.
  // If they ever come relative instead, measure from the first words.
  const base = !sorted.length ? 0 : sorted[0].start > 1e12 ? recordingStartMs : sorted[0].start;
  const lines: TranscriptLine[] = [];
  for (const s of sorted) {
    const atMs = Math.max(0, Math.round(s.start - base));
    const last = lines[lines.length - 1];
    if (last && last.speaker === s.speaker && atMs - last.atMs < 60_000) {
      last.text = `${last.text} ${s.text}`;
    } else {
      lines.push({ atMs, speaker: s.speaker, text: s.text });
    }
  }
  return lines;
}

export function clockLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Plain-text transcript: "[12:05] Bobby: text". */
export function transcriptToText(lines: TranscriptLine[]): string {
  return lines.map((l) => `[${clockLabel(l.atMs)}] ${l.speaker}: ${l.text}`).join("\n");
}
