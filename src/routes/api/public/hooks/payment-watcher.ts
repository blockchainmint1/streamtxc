// Payment watcher cron (called by pg_cron every few minutes).
//
// For every video that:
//   - has a per-video TXC wallet
//   - has not been marked paid_at
//   - has not been unpinned_at
//
// 1. Query mempool.texitcoin.org for received funds at the wallet.
// 2. If received >= payment_required_txc:
//      - stamp a "P" (payment) OP_RETURN to the same per-video wallet
//      - mark video.paid_at, status=active, payment_tx_hash, payment_received_txc
// 3. Else if past 24h grace:
//      - stamp an "X" (takedown) OP_RETURN
//      - best-effort unpin from Pinata
//      - mark video.unpinned_at, status=unpinned

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getAddressReceived, stampMessageBody } from "@/lib/txc.server";
import { recordChainEvent } from "@/lib/chain-events.server";
import { unpinByCid } from "@/lib/pinata.server";
import { PAYMENT_GRACE_HOURS } from "@/lib/fees";

export const Route = createFileRoute("/api/public/hooks/payment-watcher")({
  server: {
    handlers: {
      POST: handler,
      GET: handler, // allow manual ping during testing
    },
  },
});

async function handler() {
  const videoResults = await processVideos();
  const commentResults = await processPendingComments();
  const boostResults = await processPendingBoosts();
  return Response.json({
    ok: true,
    videos: videoResults,
    comments: commentResults,
    boosts: boostResults,
  });
}

async function processVideos() {
  const { data: pending, error } = await supabaseAdmin
    .from("videos")
    .select(
      "cid, owner_wallet, video_wallet, payment_required_txc, months_prepaid, created_at, paid_at, expires_at, payment_received_txc",
    )
    .is("unpinned_at", null)
    .not("video_wallet", "is", null)
    .limit(100);

  if (error) {
    return { ok: false, error: error.message };
  }

  const results: Array<Record<string, unknown>> = [];
  const graceMs = PAYMENT_GRACE_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  for (const v of pending ?? []) {
    if (!v.video_wallet) continue;
    const required = Number(v.payment_required_txc ?? 0);
    const received = await getAddressReceived(v.video_wallet);
    const monthsBase = v.months_prepaid ?? 1;
    const monthlyRate = required > 0 ? required / monthsBase : 0;
    // Fractional months credited: every monthlyRate TXC = 1 month of hosting.
    const monthsCredited = monthlyRate > 0 ? received / monthlyRate : 0;
    const extendedExpiresMs =
      new Date(v.created_at).getTime() + monthsCredited * 30 * 24 * 3_600_000;
    const extendedExpires = new Date(extendedExpiresMs).toISOString();

    // Already-paid video: only update expires_at if more TXC arrived (top-ups extend life).
    if (v.paid_at) {
      const prevReceived = Number(v.payment_received_txc ?? 0);
      if (received > prevReceived + 0.00000001) {
        await supabaseAdmin
          .from("videos")
          .update({
            payment_received_txc: received,
            expires_at: extendedExpires,
          })
          .eq("cid", v.cid);
        results.push({
          cid: v.cid,
          action: "extended",
          received,
          expires_at: extendedExpires,
        });
      } else {
        results.push({ cid: v.cid, action: "paid_noop", received });
      }
      continue;
    }

    if (required > 0 && received >= required) {
      // PAID — stamp proof and activate.
      try {
        const stamp = await recordChainEvent({
          cid: v.cid,
          videoWallet: v.video_wallet,
          eventType: "P",
          uploaderWallet: v.owner_wallet,
          extra: received.toFixed(4),
        });
        await supabaseAdmin
          .from("videos")
          .update({
            paid_at: new Date().toISOString(),
            payment_received_txc: received,
            payment_tx_hash: stamp.txid,
            status: "active",
            expires_at: extendedExpires,
          })
          .eq("cid", v.cid);
        results.push({
          cid: v.cid,
          action: "paid",
          received,
          months: monthsCredited,
          expires_at: extendedExpires,
          txid: stamp.txid,
        });
      } catch (err) {
        results.push({ cid: v.cid, action: "paid_failed", error: String(err) });
      }
      continue;
    }

    const ageMs = now - new Date(v.created_at).getTime();
    if (ageMs > graceMs) {
      // GRACE EXPIRED — takedown.
      try {
        const stamp = await recordChainEvent({
          cid: v.cid,
          videoWallet: v.video_wallet,
          eventType: "X",
          uploaderWallet: v.owner_wallet,
          extra: "unpaid",
        });
        await unpinByCid(v.cid);
        await supabaseAdmin
          .from("videos")
          .update({
            unpinned_at: new Date().toISOString(),
            status: "unpinned",
            payment_received_txc: received,
          })
          .eq("cid", v.cid);
        results.push({ cid: v.cid, action: "unpinned", txid: stamp.txid });
      } catch (err) {
        results.push({ cid: v.cid, action: "unpin_failed", error: String(err) });
      }
      continue;
    }

    // Still in grace, just record progress.
    if (received > 0) {
      await supabaseAdmin
        .from("videos")
        .update({ payment_received_txc: received })
        .eq("cid", v.cid);
    }
    results.push({
      cid: v.cid,
      action: "waiting",
      received,
      required,
      hoursLeft: Math.max(0, Math.ceil((graceMs - ageMs) / 3_600_000)),
    });
  }

  return { scanned: pending?.length ?? 0, results };
}

// --- Pending comments ----------------------------------------------------
//
// Split is the same 90/5/5 we used in the old trust-based flow:
//   90% creator, 5% hosting credit, 5% platform.
function splitShares(amount: number) {
  const creator = +(amount * 0.9).toFixed(8);
  const hosting = +(amount * 0.05).toFixed(8);
  const platform = +(amount - creator - hosting).toFixed(8);
  return { creator, hosting, platform };
}

async function processPendingComments() {
  const { data: pending, error } = await supabaseAdmin
    .from("comments")
    .select(
      "id, video_cid, body, deposit_wallet, payment_required_txc, pending_expires_at, created_at",
    )
    .eq("status", "pending_payment")
    .not("deposit_wallet", "is", null)
    .limit(100);
  if (error) return { ok: false, error: error.message };

  const results: Array<Record<string, unknown>> = [];
  const now = Date.now();

  for (const c of pending ?? []) {
    if (!c.deposit_wallet) continue;
    const required = Number(c.payment_required_txc ?? 0);
    const received = await getAddressReceived(c.deposit_wallet);

    if (required > 0 && received >= required) {
      // PAID — stamp the full body to chain, split shares, activate.
      try {
        const { data: video } = await supabaseAdmin
          .from("videos")
          .select("video_wallet, hosting_credit_txc")
          .eq("cid", c.video_cid)
          .maybeSingle();
        const videoWallet = video?.video_wallet ?? c.deposit_wallet;

        const stamp = await stampMessageBody({
          commentId: c.id,
          body: c.body,
          amountTxc: received,
          videoWallet,
        });
        const chunkHashes = stamp.chunks.map((s) => s.txid);

        // Persist the chain trail.
        await supabaseAdmin.from("chain_events").insert({
          video_cid: c.video_cid,
          video_wallet: videoWallet,
          event_type: "M",
          tx_hash: stamp.header.txid,
          op_return_payload: stamp.header.payload,
          to_wallet: videoWallet,
          status: stamp.header.real ? "mempool" : "stamp_failed",
          metadata: {
            comment_id: c.id,
            body_hash: stamp.bodyHash,
            chunk_count: chunkHashes.length,
            chunk_tx_hashes: chunkHashes,
          } as never,
        });

        const shares = splitShares(received);
        await supabaseAdmin
          .from("comments")
          .update({
            status: "active",
            paid_at: new Date().toISOString(),
            payment_received_txc: received,
            tx_hash: stamp.header.txid,
            op_return_payload: stamp.header.payload,
            chunk_tx_hashes: chunkHashes,
            boost_total_txc: received,
            initial_payment_txc: received,
            creator_share_txc: shares.creator,
            hosting_share_txc: shares.hosting,
            platform_share_txc: shares.platform,
            last_boost_at: new Date().toISOString(),
          })
          .eq("id", c.id);

        if (video) {
          await supabaseAdmin
            .from("videos")
            .update({
              hosting_credit_txc:
                Number(video.hosting_credit_txc ?? 0) + shares.hosting,
            })
            .eq("cid", c.video_cid);
        }

        results.push({
          comment_id: c.id,
          action: "activated",
          chunks: chunkHashes.length,
          header_tx: stamp.header.txid,
        });
      } catch (err) {
        results.push({
          comment_id: c.id,
          action: "activate_failed",
          error: String(err),
        });
      }
      continue;
    }

    if (
      c.pending_expires_at &&
      now > new Date(c.pending_expires_at).getTime()
    ) {
      await supabaseAdmin
        .from("comments")
        .update({
          status: "expired_unpaid",
          payment_received_txc: received,
        })
        .eq("id", c.id);
      results.push({ comment_id: c.id, action: "expired", received });
      continue;
    }

    if (received > 0) {
      await supabaseAdmin
        .from("comments")
        .update({ payment_received_txc: received })
        .eq("id", c.id);
    }
    results.push({ comment_id: c.id, action: "waiting", received, required });
  }

  return { scanned: pending?.length ?? 0, results };
}

async function processPendingBoosts() {
  const { data: pending, error } = await supabaseAdmin
    .from("comment_boosts")
    .select(
      "id, comment_id, deposit_wallet, payment_required_txc, pending_expires_at, created_at",
    )
    .eq("status", "pending_payment")
    .not("deposit_wallet", "is", null)
    .limit(100);
  if (error) return { ok: false, error: error.message };

  const results: Array<Record<string, unknown>> = [];
  const now = Date.now();

  for (const b of pending ?? []) {
    if (!b.deposit_wallet) continue;
    const required = Number(b.payment_required_txc ?? 0);
    const received = await getAddressReceived(b.deposit_wallet);

    if (required > 0 && received >= required) {
      try {
        const { data: comment } = await supabaseAdmin
          .from("comments")
          .select(
            "id, video_cid, boost_total_txc, creator_share_txc, hosting_share_txc, platform_share_txc",
          )
          .eq("id", b.comment_id)
          .maybeSingle();
        if (!comment) {
          results.push({ boost_id: b.id, action: "comment_missing" });
          continue;
        }
        const { data: video } = await supabaseAdmin
          .from("videos")
          .select("video_wallet, hosting_credit_txc")
          .eq("cid", comment.video_cid)
          .maybeSingle();
        const videoWallet = video?.video_wallet ?? b.deposit_wallet;

        // Single OP_RETURN for boosts (no body).
        const stamp = await recordChainEvent({
          cid: comment.video_cid,
          videoWallet,
          eventType: "B",
          uploaderWallet: "0x0000000000000000000000000000000000000000",
          extra: `${comment.id.slice(0, 8)}:${received.toFixed(4)}`,
        });

        const shares = splitShares(received);
        await supabaseAdmin
          .from("comment_boosts")
          .update({
            status: "active",
            paid_at: new Date().toISOString(),
            payment_received_txc: received,
            amount_txc: received,
            tx_hash: stamp.real ? stamp.txid : null,
            op_return_payload: stamp.payload,
          })
          .eq("id", b.id);

        await supabaseAdmin
          .from("comments")
          .update({
            boost_total_txc: Number(comment.boost_total_txc) + received,
            creator_share_txc:
              Number(comment.creator_share_txc) + shares.creator,
            hosting_share_txc:
              Number(comment.hosting_share_txc) + shares.hosting,
            platform_share_txc:
              Number(comment.platform_share_txc) + shares.platform,
            last_boost_at: new Date().toISOString(),
          })
          .eq("id", comment.id);

        if (video) {
          await supabaseAdmin
            .from("videos")
            .update({
              hosting_credit_txc:
                Number(video.hosting_credit_txc ?? 0) + shares.hosting,
            })
            .eq("cid", comment.video_cid);
        }

        results.push({ boost_id: b.id, action: "activated", tx: stamp.txid });
      } catch (err) {
        results.push({
          boost_id: b.id,
          action: "activate_failed",
          error: String(err),
        });
      }
      continue;
    }

    if (
      b.pending_expires_at &&
      now > new Date(b.pending_expires_at).getTime()
    ) {
      await supabaseAdmin
        .from("comment_boosts")
        .update({
          status: "expired_unpaid",
          payment_received_txc: received,
        })
        .eq("id", b.id);
      results.push({ boost_id: b.id, action: "expired", received });
      continue;
    }

    if (received > 0) {
      await supabaseAdmin
        .from("comment_boosts")
        .update({ payment_received_txc: received })
        .eq("id", b.id);
    }
    results.push({ boost_id: b.id, action: "waiting", received, required });
  }

  return { scanned: pending?.length ?? 0, results };
}