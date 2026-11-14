// Signed "I'm leaving" tokens so only the person holding a seat can free it
// (other people in the room can see attendee IDs, so the ID alone isn't proof).

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
