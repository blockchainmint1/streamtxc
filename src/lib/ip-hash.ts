// Keyed (HMAC) hashes of visitor IP addresses. A plain SHA-256 of an IPv4
// address can be reversed by trying all 4 billion addresses; an HMAC with a
// server-only key can't. Each use gets its own label so hashes from one table
// can't be matched against another.
export async function keyedIpHash(purpose: "report" | "view", ip: string, secret = process.env.SESSION_SECRET): Promise<string> {
  if (!secret) throw new Error("SESSION_SECRET is not configured.");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(`ip-hash|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${purpose}|${ip}`));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
