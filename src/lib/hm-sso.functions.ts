// "Sign in with honest.money" — verifies the HMAC ticket honest.money sends
// back to /sso (see honest.money/api section 1). streamTXC accounts are TXC
// wallets, so each member links a wallet once; later logins map member → wallet.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";
import { sendHubEvent } from "./hm-hub.server";
import { verifyHmeTicket, hmeRedirect, linkedHmeWallet } from "./hme-protocol";
import {
  issueHmLinkToken,
  issueSessionToken,
  verifyHmLinkToken,
} from "./wallet-auth.server";

export const completeHmSso = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().min(10).max(4000), ref: z.string().max(64).optional() }).parse(d))
  .handler(async ({ data }) => {
    const secret = process.env.HME_ECOSYSTEM;
    if (!secret) throw new Error("Honest.money sign-in isn't configured yet.");
    const t = await verifyHmeTicket(data.token, secret);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Single-use nonce.
    const { error: nErr } = await supabaseAdmin
      .from("hm_sso_nonces")
      .insert({ nonce: t.nonce, expires_at: new Date(t.exp * 1000).toISOString() });
    if (nErr) throw new Error(nErr.code === "23505"
      ? "This sign-in ticket was already used — try again."
      : "Could not finish sign-in — try again.");
    await supabaseAdmin.from("hm_sso_nonces").delete().lt("expires_at", new Date().toISOString());

    const memberId = String(t.minerId).toLowerCase();
    const redirect = hmeRedirect(t.redirect);
    const { data: existing, error: lookupError } = await supabaseAdmin
      .from("hm_sso_links")
      .select("wallet,status")
      .eq("member_id", memberId)
      .maybeSingle();
    if (lookupError) throw new Error("Could not find your account — try again.");
    const wallet = linkedHmeWallet(existing);
    void sendHubEvent({ event: "service_used", memberId, ref: data.ref, metadata: { action: "sign_in" } });
    // The permanent UUID owns this association. Email is contact data only.
    if (wallet) {
      const { error: updateError } = await supabaseAdmin
        .from("hm_sso_links")
        .update({ last_login_at: new Date().toISOString(), email: t.email ?? null })
        .eq("member_id", memberId);
      if (updateError) throw new Error("Could not finish sign-in — try again.");
      const s = await issueSessionToken(wallet, getRequestHeader("user-agent"));
      return { kind: "signed-in" as const, wallet, token: s.token, expiresAt: s.expiresAt, redirect };
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
    const { error } = await supabaseAdmin.from("hm_sso_links").insert({
      member_id: c.memberId,
      wallet: context.wallet,
      email: c.email,
      last_login_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.code === "23505"
      ? "This HME account is already linked. Sign in again; contact support to change its wallet."
      : "Could not link your wallet — try again.");
    void sendHubEvent({ event: "signup", memberId: c.memberId, metadata: { action: "wallet_linked" } });
    return { ok: true };
  });
