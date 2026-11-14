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
