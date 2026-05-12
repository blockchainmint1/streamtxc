// Pay-to-comment server functions.
//
// Pricing model: minimum 0.01 TXC, user picks any amount above that. Higher
// amounts boost the comment higher in the ranking.
//
// Split (per user request):
//   90% → creator (per-video wallet)
//    5% → hosting credit (accrues on videos.hosting_credit_txc)
//    5% → platform
//
// Ranking: client-side score = boost_total_txc / (1 + ageHoursSinceLastBoost / 24)
// so boosts decay back down. Server returns the raw rows; UI sorts.
//
// On-chain stamp: each comment is anchored with an `M` OP_RETURN event;
// each boost with a `B` event. If the RPC is unreachable the recordChainEvent
// helper degrades gracefully (placeholder txid, status=stamp_failed) so the
// comment still posts.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordChainEvent } from "./chain-events.server";
import { mockPaymentTx } from "./chain";
import { explorerTxUrl } from "./txc.server";

const walletSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address");

const optionalWalletSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined))
  .refine(
    (v) => v === undefined || /^0x[a-fA-F0-9]{40}$/.test(v),
    "Invalid wallet address",
  );

const MIN_TXC = 0.01;
const MAX_TXC = 10000;
const MAX_BODY_LEN = 1000;

export const COMMENT_PRICING = {
  minTxc: MIN_TXC,
  creatorPct: 0.9,
  hostingPct: 0.05,
  platformPct: 0.05,
};

function splitShares(amount: number) {
  const creator = +(amount * COMMENT_PRICING.creatorPct).toFixed(8);
  const hosting = +(amount * COMMENT_PRICING.hostingPct).toFixed(8);
  // Platform takes the remainder so the three shares sum exactly to amount
  // (avoids rounding drift on big numbers).
  const platform = +(amount - creator - hosting).toFixed(8);
  return { creator, hosting, platform };
}

// --- Post a new comment ----------------------------------------------------

export const postComment = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        videoCid: z.string().min(1).max(200),
        body: z.string().trim().min(1).max(MAX_BODY_LEN),
        amountTxc: z.number().min(MIN_TXC).max(MAX_TXC),
        commenterWallet: optionalWalletSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // Make sure the video exists and isn't hidden.
    const { data: video, error: vErr } = await supabaseAdmin
      .from("videos")
      .select("cid, video_wallet, hidden_at, hosting_credit_txc")
      .eq("cid", data.videoCid)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!video) throw new Error("Video not found");
    if (video.hidden_at) throw new Error("Comments disabled on hidden videos");

    const shares = splitShares(data.amountTxc);

    // Anchor the comment on chain. Use the video wallet as the recipient
    // so the video's address page accumulates a complete public history.
    // Stamper signature falls back to `0x0…0` for anonymous comments.
    const stamperWallet =
      data.commenterWallet ?? "0x0000000000000000000000000000000000000000";
    const stamp = await recordChainEvent({
      cid: data.videoCid,
      videoWallet: video.video_wallet ?? stamperWallet,
      eventType: "M",
      uploaderWallet: stamperWallet,
      extra: data.amountTxc.toFixed(4),
    });

    const paymentTx = mockPaymentTx(stamperWallet, data.amountTxc);

    const { data: inserted, error: cErr } = await supabaseAdmin
      .from("comments")
      .insert({
        video_cid: data.videoCid,
        body: data.body,
        commenter_wallet: data.commenterWallet ?? null,
        initial_payment_txc: data.amountTxc,
        boost_total_txc: data.amountTxc,
        creator_share_txc: shares.creator,
        hosting_share_txc: shares.hosting,
        platform_share_txc: shares.platform,
        tx_hash: stamp.real ? stamp.txid : null,
        op_return_payload: stamp.payload,
        mock_tx_hash: paymentTx,
        last_boost_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (cErr) throw new Error(`Failed to post comment: ${cErr.message}`);

    // Accrue hosting credit on the video.
    await supabaseAdmin
      .from("videos")
      .update({
        hosting_credit_txc:
          Number(video.hosting_credit_txc ?? 0) + shares.hosting,
      })
      .eq("cid", data.videoCid);

    return {
      id: inserted.id,
      txHash: stamp.real ? stamp.txid : null,
      explorerUrl: stamp.real ? explorerTxUrl(stamp.txid) : null,
      shares,
    };
  });

// --- Boost an existing comment --------------------------------------------

export const boostComment = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        commentId: z.string().uuid(),
        amountTxc: z.number().min(MIN_TXC).max(MAX_TXC),
        boosterWallet: optionalWalletSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: comment, error: cErr } = await supabaseAdmin
      .from("comments")
      .select(
        "id, video_cid, boost_total_txc, creator_share_txc, hosting_share_txc, platform_share_txc",
      )
      .eq("id", data.commentId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!comment) throw new Error("Comment not found");

    const { data: video, error: vErr } = await supabaseAdmin
      .from("videos")
      .select("video_wallet, hidden_at, hosting_credit_txc")
      .eq("cid", comment.video_cid)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!video) throw new Error("Video not found");
    if (video.hidden_at) throw new Error("Boosts disabled on hidden videos");

    const shares = splitShares(data.amountTxc);
    const stamperWallet =
      data.boosterWallet ?? "0x0000000000000000000000000000000000000000";

    const stamp = await recordChainEvent({
      cid: comment.video_cid,
      videoWallet: video.video_wallet ?? stamperWallet,
      eventType: "B",
      uploaderWallet: stamperWallet,
      extra: `${comment.id.slice(0, 8)}:${data.amountTxc.toFixed(4)}`,
    });

    const paymentTx = mockPaymentTx(stamperWallet, data.amountTxc);

    const { error: bErr } = await supabaseAdmin.from("comment_boosts").insert({
      comment_id: data.commentId,
      booster_wallet: data.boosterWallet ?? null,
      amount_txc: data.amountTxc,
      tx_hash: stamp.real ? stamp.txid : null,
      op_return_payload: stamp.payload,
      mock_tx_hash: paymentTx,
    });
    if (bErr) throw new Error(`Failed to record boost: ${bErr.message}`);

    // Update aggregate totals on the comment + bump last_boost_at so the
    // decay clock resets.
    const { error: uErr } = await supabaseAdmin
      .from("comments")
      .update({
        boost_total_txc: Number(comment.boost_total_txc) + data.amountTxc,
        creator_share_txc:
          Number(comment.creator_share_txc) + shares.creator,
        hosting_share_txc:
          Number(comment.hosting_share_txc) + shares.hosting,
        platform_share_txc:
          Number(comment.platform_share_txc) + shares.platform,
        last_boost_at: new Date().toISOString(),
      })
      .eq("id", data.commentId);
    if (uErr) throw new Error(`Failed to update boost total: ${uErr.message}`);

    await supabaseAdmin
      .from("videos")
      .update({
        hosting_credit_txc:
          Number(video.hosting_credit_txc ?? 0) + shares.hosting,
      })
      .eq("cid", comment.video_cid);

    return {
      txHash: stamp.real ? stamp.txid : null,
      explorerUrl: stamp.real ? explorerTxUrl(stamp.txid) : null,
      shares,
    };
  });

// --- Listing --------------------------------------------------------------

export const listComments = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ videoCid: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("comments")
      .select(
        "id, body, commenter_wallet, initial_payment_txc, boost_total_txc, last_boost_at, created_at, tx_hash",
      )
      .eq("video_cid", data.videoCid)
      .eq("status", "active")
      .is("hidden_at", null)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => ({
      ...r,
      explorerUrl: r.tx_hash ? explorerTxUrl(r.tx_hash) : null,
    }));
  });

// Re-export so the client can reference walletSchema when needed.
export const _walletSchema = walletSchema;