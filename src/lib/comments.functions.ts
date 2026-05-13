// Pay-to-comment server functions (Option A: per-comment deposit wallet).
//
// Flow:
//   1. createCommentIntent: derive a fresh deposit wallet, insert row as
//      status='pending_payment' with a 30-min grace window. Return the
//      address + amount + QR payload to the UI.
//   2. UI polls getCommentStatus until status flips to 'active'.
//   3. payment-watcher cron checks each pending wallet for incoming TXC.
//      When received >= required: stamp the FULL body across N OP_RETURN
//      chunks (header + body chunks all sent to the per-video wallet),
//      split shares 90/5/5, accrue hosting credit, flip status='active'.
//   4. If the grace window expires unpaid: status='expired_unpaid' (hidden).
//
// Boosts follow the same pattern (amounts only, no body to chunk).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { explorerTxUrl } from "./txc.server";
import { assignVideoWallet } from "./txc-wallets.server";

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
const GRACE_MIN = 30;

export const COMMENT_PRICING = {
  minTxc: MIN_TXC,
  creatorPct: 0.9,
  hostingPct: 0.05,
  platformPct: 0.05,
  graceMinutes: GRACE_MIN,
};

// --- Create a pending comment intent -------------------------------------

export const createCommentIntent = createServerFn({ method: "POST" })
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
    const { data: video, error: vErr } = await supabaseAdmin
      .from("videos")
      .select("cid, video_wallet, hidden_at")
      .eq("cid", data.videoCid)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!video) throw new Error("Video not found");
    if (video.hidden_at) throw new Error("Comments disabled on hidden videos");

    // Derive a fresh address for this comment's deposit.
    const wallet = await assignVideoWallet();
    const expiresAt = new Date(Date.now() + GRACE_MIN * 60_000).toISOString();
    const bodyHash = createHash("sha256")
      .update(data.body, "utf8")
      .digest("hex");

    const { data: inserted, error: cErr } = await supabaseAdmin
      .from("comments")
      .insert({
        video_cid: data.videoCid,
        body: data.body,
        body_hash: bodyHash,
        commenter_wallet: data.commenterWallet ?? null,
        initial_payment_txc: data.amountTxc,
        boost_total_txc: 0, // becomes amountTxc on payment confirmation
        status: "pending_payment",
        deposit_wallet: wallet.address,
        derivation_index: wallet.derivationIndex,
        payment_required_txc: data.amountTxc,
        pending_expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (cErr) throw new Error(`Failed to create comment intent: ${cErr.message}`);

    return {
      commentId: inserted.id,
      depositWallet: wallet.address,
      amountTxc: data.amountTxc,
      expiresAt,
      graceMinutes: GRACE_MIN,
    };
  });

// --- Create a pending boost intent ---------------------------------------

export const createBoostIntent = createServerFn({ method: "POST" })
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
      .select("id, video_cid, status")
      .eq("id", data.commentId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!comment) throw new Error("Comment not found");
    if (comment.status !== "active")
      throw new Error("Comment is not active yet");

    const { data: video, error: vErr } = await supabaseAdmin
      .from("videos")
      .select("video_wallet, hidden_at")
      .eq("cid", comment.video_cid)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!video) throw new Error("Video not found");
    if (video.hidden_at) throw new Error("Boosts disabled on hidden videos");

    const wallet = await assignVideoWallet();
    const expiresAt = new Date(Date.now() + GRACE_MIN * 60_000).toISOString();

    const { data: inserted, error: bErr } = await supabaseAdmin
      .from("comment_boosts")
      .insert({
        comment_id: data.commentId,
        booster_wallet: data.boosterWallet ?? null,
        amount_txc: data.amountTxc,
        status: "pending_payment",
        deposit_wallet: wallet.address,
        derivation_index: wallet.derivationIndex,
        payment_required_txc: data.amountTxc,
        pending_expires_at: expiresAt,
      })
      .select("id")
      .single();
    if (bErr) throw new Error(`Failed to create boost intent: ${bErr.message}`);

    return {
      boostId: inserted.id,
      depositWallet: wallet.address,
      amountTxc: data.amountTxc,
      expiresAt,
      graceMinutes: GRACE_MIN,
    };
  });

// --- Status polling ------------------------------------------------------

export const getCommentStatus = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ commentId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("comments")
      .select(
        "id, status, payment_received_txc, payment_required_txc, pending_expires_at, paid_at, tx_hash, comment_cid",
      )
      .eq("id", data.commentId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Comment not found");
    return {
      ...row,
      explorerUrl: row.tx_hash ? explorerTxUrl(row.tx_hash) : null,
      ipfsUrl: row.comment_cid ? `/api/stream/${row.comment_cid}` : null,
    };
  });

export const getBoostStatus = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ boostId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("comment_boosts")
      .select(
        "id, status, payment_received_txc, payment_required_txc, pending_expires_at, paid_at, tx_hash",
      )
      .eq("id", data.boostId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Boost not found");
    return {
      ...row,
      explorerUrl: row.tx_hash ? explorerTxUrl(row.tx_hash) : null,
    };
  });

// --- Listing -------------------------------------------------------------

export const listComments = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ videoCid: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("comments")
      .select(
        "id, body, commenter_wallet, initial_payment_txc, boost_total_txc, last_boost_at, created_at, tx_hash, comment_cid",
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
      ipfsUrl: r.comment_cid ? `/api/stream/${r.comment_cid}` : null,
    }));
  });
