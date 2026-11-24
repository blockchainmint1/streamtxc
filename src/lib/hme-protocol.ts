import { z } from "zod";

export const HME_SITE = "streamtxc";
export const HME_ISSUER = "honest.money";
export const BLOCKED_STATUSES = ["blocked", "ban"];

const ticketSchema = z.object({
  iss: z.literal(HME_ISSUER),
  site: z.literal(HME_SITE),
  minerId: z.uuid().transform((id) => id.toLowerCase()),
  email: z.email().max(320).optional(),
  exp: z.number().int().positive(),
  nonce: z.string().min(1).max(200),
  redirect: z.string().max(2000).optional(),
});

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyHmeTicket(token: string, secret: string, now = Date.now()) {
  const parts = token.split(".");
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature || !/^[a-fA-F0-9]{64}$/.test(signature)) {
    throw new Error("Invalid sign-in ticket.");
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body))) {
    throw new Error("Invalid sign-in ticket.");
  }
  let ticket;
  try {
    const pad = "=".repeat((4 - body.length % 4) % 4);
    const binary = atob(body.replace(/-/g, "+").replace(/_/g, "/") + pad);
    ticket = ticketSchema.parse(JSON.parse(new TextDecoder().decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    )));
  } catch {
    throw new Error("Invalid sign-in ticket or wrong HME site.");
  }
  if (ticket.exp * 1000 <= now || ticket.exp * 1000 > now + 120_000) {
    throw new Error("Sign-in ticket expired — try again.");
  }
  return ticket;
}

// Only honor landing pages that actually exist on streamTXC; HME may send its own paths (e.g. "/my").
const HME_REDIRECT_PAGES = ["about", "brand", "embed", "live", "manage", "manifesto", "meet", "privacy", "terms", "u", "upload", "v"];

export function hmeRedirect(redirect?: string): string | null {
  if (!redirect || !redirect.startsWith("/") || redirect.startsWith("//") || /[\\\u0000-\u001f]/.test(redirect)) return null;
  const first = redirect.slice(1).split(/[/?#]/)[0];
  // "/" (home) isn't a useful landing page after sign-in; fall back to the account page.
  if (first === "" || !HME_REDIRECT_PAGES.includes(first)) return null;
  return redirect;
}

export function linkedHmeWallet(link: { wallet: string; status: string } | null): string | null {
  if (link && BLOCKED_STATUSES.includes(link.status)) {
    throw new Error("This account can't sign in. Contact support@honest.money.");
  }
  return link?.wallet ?? null;
}

export const hmeProfileUpdateSchema = z.object({
  minerId: z.uuid().transform((id) => id.toLowerCase()),
  status: z.enum(["active", "blocked", "ban", "oceanfront"]).optional(),
  fullName: z.string().max(200).optional(),
  newEmail: z.email().max(320).transform((email) => email.toLowerCase()).optional(),
});