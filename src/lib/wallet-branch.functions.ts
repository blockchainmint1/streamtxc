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

// Step 5: file videos that were posted BEFORE the owner shared their branch.
// Runs a small batch per call (each video gets a real on-chain claim stamp,
// so batches stay short); the client loops until `remaining` hits zero.
export const moveVideosToOwnerBranch = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z.object({ batch: z.number().int().min(1).max(8).optional() }).parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { fileVideoInOwnerBranch } = await import("./owner-branch.server");
    const batch = data?.batch ?? 4;
    const { data: vids } = await supabaseAdmin
      .from("videos")
      .select("cid")
      .eq("owner_wallet", context.wallet)
      .is("owner_branch_address", null)
      .order("created_at", { ascending: true })
      .limit(batch);
    let filed = 0;
    for (const v of vids ?? []) {
      const addr = await fileVideoInOwnerBranch({ cid: v.cid, ownerWallet: context.wallet });
      if (addr) filed++;
    }
    const { count } = await supabaseAdmin
      .from("videos")
      .select("cid", { count: "exact", head: true })
      .eq("owner_wallet", context.wallet)
      .is("owner_branch_address", null);
    return { filed, remaining: count ?? 0 };
  });
