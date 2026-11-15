// Signed "I'm leaving" / "I'm still here" tokens so only the person holding a
// seat can free it or keep it alive (other people in the room can see
// attendee IDs, so the ID alone isn't proof).

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The seat-token key. Required: without it seats could never be freed and
 * hosts would pay for people who left. Falls back to a purpose-separated key
 * derived from SESSION_SECRET; throws when neither exists (fail closed).
 */
export async function leaveSecret(env: { MEETING_LEAVE_SECRET?: string; SESSION_SECRET?: string } = process.env): Promise<string> {
  const direct = env.MEETING_LEAVE_SECRET?.trim();
  if (direct) return direct;
  const session = env.SESSION_SECRET?.trim();
  if (session) return hmacHex(session, "streamtxc-meet-leave-key-v1");
  throw new Error("Meeting seat key is not configured.");
}

export function signLeaveToken(secret: string, meetingId: string, attendeeId: string) {
  return hmacHex(secret, `meet-leave|${meetingId}|${attendeeId}`);
}

export async function verifyLeaveToken(secret: string, meetingId: string, attendeeId: string, token: string) {
  const expected = await signLeaveToken(secret, meetingId, attendeeId);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
