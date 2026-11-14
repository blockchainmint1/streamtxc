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
