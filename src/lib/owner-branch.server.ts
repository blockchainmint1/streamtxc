// Files a new video into its owner's own HME Wallet branch (1105), when the
// owner has shared that branch. Best-effort: never blocks an upload.
// Money keeps flowing through our own per-video address (video_wallet) so
// the 90/5/5 split is unchanged — only the ownership record moves.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deriveBranchAddress } from "./branch-xpub.server";
import { recordChainEvent } from "./chain-events.server";

export async function fileVideoInOwnerBranch(opts: {
  cid: string;
  ownerWallet: string | null | undefined;
}): Promise<string | null> {
  try {
    if (!opts.ownerWallet) return null;
    const { data: link } = await supabaseAdmin
      .from("wallet_branch_links")
      .select("xpub")
      .eq("wallet", opts.ownerWallet)
      .maybeSingle();
    if (!link?.xpub) return null;

    const { data: idx, error } = await supabaseAdmin.rpc("claim_branch_index", {
      _wallet: opts.ownerWallet,
    });
    if (error || idx == null) return null;
    const index = Number(idx);
    const address = deriveBranchAddress(link.xpub, index);

    await supabaseAdmin
      .from("videos")
      .update({ owner_branch_address: address, owner_branch_index: index })
      .eq("cid", opts.cid);

    await recordChainEvent({
      cid: opts.cid,
      videoWallet: address,
      eventType: "C",
      uploaderWallet: opts.ownerWallet,
      metadata: { owner_branch: true, path: `1105'/0/${index}` },
    });
    return address;
  } catch (e) {
    console.error("[owner-branch] filing failed", e);
    return null;
  }
}
