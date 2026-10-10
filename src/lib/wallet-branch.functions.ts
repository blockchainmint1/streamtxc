import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";
import { BRANCH_XPUB_PATH, LINK_TTL_SECONDS } from "./wallet-branch";
import { publicOrigin } from "./site-origin";

function manifestUrl(token: string): string {
  return `${publicOrigin()}/api/public/v1/wallet-link?token=${token}`;
}

export const createBranchShareRequest = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = crypto.randomUUID().replace(/-/g, "");
    const challenge = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString();
    const { error } = await supabaseAdmin.from("wallet_branch_requests").insert({
      token,
      challenge,
      wallet: context.wallet,
      expires_at: expiresAt,
    });
    if (error) throw new Error(error.message);
    const url = manifestUrl(token);
    return { token, manifestUrl: url, qrPayload: `hm-link:${url}`, expiresAt, path: BRANCH_XPUB_PATH };
  });

export const getMyBranchShare = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z.object({ token: z.string().trim().min(8).max(64).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: link } = await supabaseAdmin
      .from("wallet_branch_links")
      .select("identity_address, xpub_path, next_index, linked_at")
      .eq("wallet", context.wallet)
      .maybeSingle();
    let requestError: string | null = null;
    if (data.token) {
      const { data: row } = await supabaseAdmin
        .from("wallet_branch_requests")
        .select("status, error")
        .eq("token", data.token)
        .eq("wallet", context.wallet)
        .maybeSingle();
      requestError = row?.status === "failed" ? row.error : null;
    }
    return {
      linked: !!link,
      identityAddress: link?.identity_address ?? null,
      path: link?.xpub_path ?? null,
      videosFiled: link?.next_index ?? 0,
      linkedAt: link?.linked_at ?? null,
      requestError,
    };
  });

export const unshareBranch = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("wallet_branch_links").delete().eq("wallet", context.wallet);
    return { ok: true };
  });
