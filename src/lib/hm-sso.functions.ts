// "Sign in with honest.money" — verifies the HMAC ticket honest.money sends
// back to /sso (see honest.money/api section 1). streamTXC accounts are TXC
// wallets, so each member links a wallet once; later logins map member → wallet.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";
import { BLOCKED_STATUSES, sendHubEvent } from "./hm-hub.server";
import {
  issueHmLinkToken,
  issueSessionToken,
  verifyHmLinkToken,
} from "./wallet-auth.server";

function b64urlToString(s: string): string {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const completeHmSso = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().min(10).max(4000), ref: z.string().max(64).optional() }).parse(d))
  .handler(async ({ data }) => {
    const secret = process.env.HME_HMAC_SECRET;
    if (!secret) throw new Error("Honest.money sign-in isn't configured yet.");
    const [body, sig] = data.token.split(".");
    if (!body || !sig) throw new Error("Invalid sign-in ticket.");
    const mac = await hmacHex(secret, body);
    if (!safeEqual(mac, sig.toLowerCase())) throw new Error("Invalid sign-in ticket.");
    let t: { minerId?: string; email?: string; exp?: number; nonce?: string; redirect?: string };
    try {
      t = JSON.parse(b64urlToString(body));
    } catch {
      throw new Error("Invalid sign-in ticket.");
    }
    if (!t.minerId || !t.nonce || !t.exp || t.exp * 1000 < Date.now()) {
      throw new Error("Sign-in ticket expired — try again.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Single-use nonce.
    const { error: nErr } = await supabaseAdmin
      .from("hm_sso_nonces")
      .insert({ nonce: t.nonce, expires_at: new Date(t.exp * 1000).toISOString() });
    if (nErr) throw new Error("This sign-in ticket was already used — try again.");
    void supabaseAdmin.from("hm_sso_nonces").delete().lt("expires_at", new Date().toISOString());

    const memberId = String(t.minerId).toLowerCase();
    const redirect =
      typeof t.redirect === "string" && t.redirect.startsWith("/") && !t.redirect.startsWith("//")
        ? t.redirect
        : null;
    const { data: existing } = await supabaseAdmin
      .from("hm_sso_links")
      .select("status")
      .eq("member_id", memberId)
      .maybeSingle();
    if (existing && BLOCKED_STATUSES.includes(existing.status)) {
      throw new Error("This account can't sign in. Contact support@honest.money.");
    }
    void sendHubEvent({ event: "service_used", memberId, ref: data.ref, metadata: { action: "sign_in" } });
    // One-time bootstrap: known owners get their wallet linked automatically
    // the first time they sign in with honest.money (no manual link step).
    const BOOTSTRAP_LINKS: Record<string, string> = {
      "bobby@honest.money": "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m",
    };
    const bootstrapWallet = t.email ? BOOTSTRAP_LINKS[t.email.toLowerCase()] : undefined;
    if (bootstrapWallet) {
      await supabaseAdmin.from("hm_sso_links").upsert({
        member_id: memberId,
        wallet: bootstrapWallet,
        email: t.email ?? null,
        last_login_at: new Date().toISOString(),
      });
      const s = await issueSessionToken(bootstrapWallet);
      return { kind: "signed-in" as const, wallet: bootstrapWallet, token: s.token, expiresAt: s.expiresAt, redirect };
    }
    const { data: link } = await supabaseAdmin
      .from("hm_sso_links")
      .select("wallet")
      .eq("member_id", memberId)
      .maybeSingle();
    if (link?.wallet) {
      await supabaseAdmin
        .from("hm_sso_links")
        .update({ last_login_at: new Date().toISOString(), email: t.email ?? null })
        .eq("member_id", memberId);
      const s = await issueSessionToken(link.wallet);
      return { kind: "signed-in" as const, wallet: link.wallet, token: s.token, expiresAt: s.expiresAt, redirect };
    }
    return {
      kind: "needs-link" as const,
      email: t.email ?? null,
      linkToken: await issueHmLinkToken(memberId, t.email ?? null),
    };
  });

export const linkHmMember = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((d) => z.object({ linkToken: z.string().min(10).max(4000) }).parse(d))
  .handler(async ({ data, context }) => {
    const c = await verifyHmLinkToken(data.linkToken);
    if (!c) throw new Error("Link request expired — sign in with honest.money again.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("hm_sso_links").upsert({
      member_id: c.memberId,
      wallet: context.wallet,
      email: c.email,
      last_login_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    void sendHubEvent({ event: "signup", memberId: c.memberId, metadata: { action: "wallet_linked" } });
    return { ok: true };
  });
