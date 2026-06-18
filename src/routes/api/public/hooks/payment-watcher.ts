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
import {
  getAddressReceived,
  stampCommentCid,
  getPlatformAddress,
  stampEvent,
} from "@/lib/txc.server";
import { recordChainEvent } from "@/lib/chain-events.server";
import {
  unpinByCid,
  pinJsonToIPFS,
  pinByCid,
  headCidOnGateway,
} from "@/lib/pinata.server";
import { PAYMENT_GRACE_HOURS } from "@/lib/fees";
import { sweepCommentPayout } from "@/lib/videos.functions";
import { recordSplitPayout } from "@/lib/chain-events.server";
import { deliverAlert } from "@/lib/notifications.server";

// How long after expires_at we keep the file pinned before actually
// removing from Pinata. Metadata + DB row stay forever.
const POST_EXPIRY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
// How far in advance we warn the owner that a video is about to expire.
const PRE_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

function explorerVideoUrl(cid: string) {
  const base = process.env.APP_PUBLIC_URL ?? "https://streamtxc.com";
  return `${base}/v/${cid}`;
}

function manageUrl() {
  const base = process.env.APP_PUBLIC_URL ?? "https://streamtxc.com";
  return `${base}/manage`;
}

// Boost is just additional comment revenue — apply the same 90/5/5 split
// against the boost amount (not the cumulative comment total) and log it.
// Creator share is escrowed if the video owner isn't verified yet.
async function sweepBoostPayout(
  _boostId: string,
  amount: number,
  videoCid: string,
): Promise<{ ok: boolean; status: string; details: Record<string, string> }> {
  const { data: video } = await supabaseAdmin
    .from("videos")
    .select(
      "cid, video_wallet, owner_wallet, owner_proof_status, escrowed_creator_txc",
    )
    .eq("cid", videoCid)
    .maybeSingle();
  if (!video)
    return { ok: false, status: "failed", details: { error: "video missing" } };

  const hostingAddr = process.env.TXC_HOSTING_ADDRESS;
  if (!hostingAddr) {
    return {
      ok: false,
      status: "failed",
      details: { error: "hosting addr not configured" },
    };
  }
  let platformAddr: string;
  try {
    platformAddr = await getPlatformAddress();
  } catch (e) {
    return {
      ok: false,
      status: "failed",
      details: { error: `platform addr resolve failed: ${String(e)}` },
    };
  }

  const creatorAmt = +(amount * 0.9).toFixed(8);
  const hostingAmt = +(amount * 0.05).toFixed(8);
  const platformAmt = +(amount - creatorAmt - hostingAmt).toFixed(8);

  const details: Record<string, string> = {};
  let allOk = true;

  try {
    const r = await recordSplitPayout({
      videoCid,
      videoWallet: video.video_wallet ?? platformAddr,
      commentId: _boostId,
      toAddress: platformAddr,
      amountTxc: platformAmt,
      kind: "platform",
    });
    details.platform = r?.txid ?? "skipped";
  } catch (e) {
    allOk = false;
    details.platform_error = String(e);
  }

  try {
    const r = await recordSplitPayout({
      videoCid,
      videoWallet: video.video_wallet ?? hostingAddr,
      commentId: _boostId,
      toAddress: hostingAddr,
      amountTxc: hostingAmt,
      kind: "hosting",
    });
    details.hosting = r?.txid ?? "skipped";
  } catch (e) {
    allOk = false;
    details.hosting_error = String(e);
  }

  if (video.owner_proof_status === "verified" && video.owner_wallet) {
    try {
      const r = await recordSplitPayout({
        videoCid,
        videoWallet: video.video_wallet ?? video.owner_wallet,
        commentId: _boostId,
        toAddress: video.owner_wallet,
        amountTxc: creatorAmt,
        kind: "creator",
      });
      details.creator = r?.txid ?? "skipped";
    } catch (e) {
      allOk = false;
      details.creator_error = String(e);
    }
  } else {
    const newEscrow =
      Number(video.escrowed_creator_txc ?? 0) + creatorAmt;
    await supabaseAdmin
      .from("videos")
      .update({ escrowed_creator_txc: newEscrow })
      .eq("cid", videoCid);
    details.creator = "escrowed";
  }

  return {
    ok: allOk,
    status: !allOk
      ? "partial"
      : details.creator === "escrowed"
        ? "escrowed"
        : "swept",
    details,
  };
}

export const Route = createFileRoute("/api/public/hooks/payment-watcher")({
  server: {
    handlers: {
      POST: handler,
      GET: handler, // allow manual ping during testing
    },
  },
});

async function handler({ request }: { request: Request }) {
  // Guard with the same x-admin-token / TXC_RPC_PASS pattern used by
  // /api/public/admin/retry-stamps. Stops anonymous callers from triggering
  // expensive blockchain RPCs, payout splits, and unpins.
  const expected = process.env.TXC_RPC_PASS;
  const provided = request.headers.get("x-admin-token");
  if (!expected || provided !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
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

async function retryFailedPaymentStampForPaidVideo(v: {
  cid: string;
  owner_wallet: string;
  video_wallet: string;
}) {
  const { data: failedP } = await supabaseAdmin
    .from("chain_events")
    .select("id")
    .eq("video_cid", v.cid)
    .eq("event_type", "P")
    .eq("status", "stamp_failed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!failedP) return null;

  const stamp = await stampEvent({
    cid: v.cid,
    wallet: v.owner_wallet,
    eventType: "P",
    toAddress: v.video_wallet,
  });

  if (!stamp.real) {
    throw new Error("payment proof retry stayed in stub mode");
  }

  await supabaseAdmin
    .from("chain_events")
    .update({
      tx_hash: stamp.txid,
      op_return_payload: stamp.payload,
      status: "mempool",
    })
    .eq("id", failedP.id);

  await supabaseAdmin
    .from("videos")
    .update({ payment_tx_hash: stamp.txid })
    .eq("cid", v.cid);

  return stamp.txid;
}

async function processVideos() {
  const { data: pending, error } = await supabaseAdmin
    .from("videos")
    .select(
      "cid, title, owner_wallet, video_wallet, payment_required_txc, months_prepaid, created_at, paid_at, expires_at, payment_received_txc, unpinned_at, status, expiring_at, unpin_after, notified_pre_expiry_at, notified_expiring_at, notified_unpinned_at",
    )
    .not("video_wallet", "is", null)
    .limit(1000);

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

    // Unpinned video: if a renewal payment landed (delta >= one month's worth),
    // re-pin from IPFS, stamp R, reactivate. If the bytes are no longer
    // fetchable from any peer the row stays unpinned and the owner re-seed
    // flow takes over — but the payment is now tracked.
    if (v.unpinned_at) {
      const prevReceived = Number(v.payment_received_txc ?? 0);
      const delta = received - prevReceived;
      if (monthlyRate > 0 && delta >= monthlyRate - 0.00000001) {
        try {
          await pinByCid(v.cid, v.cid);
          // Give Pinata a moment, then probe. Single attempt — cron retries.
          const available = await headCidOnGateway(v.cid, 4000);
          if (!available) {
            results.push({
              cid: v.cid,
              action: "restore_pin_unavailable",
              received,
              delta,
            });
            continue;
          }
          const stamp = await recordChainEvent({
            cid: v.cid,
            videoWallet: v.video_wallet,
            eventType: "R",
            uploaderWallet: v.owner_wallet ?? "anon",
            extra: delta.toFixed(4),
          });
          await supabaseAdmin
            .from("videos")
            .update({
              unpinned_at: null,
              status: "active",
              paid_at: v.paid_at ?? new Date().toISOString(),
              payment_received_txc: received,
              payment_tx_hash: stamp.txid,
              expires_at: extendedExpires,
              expiring_at: null,
              unpin_after: null,
              notified_pre_expiry_at: null,
              notified_expiring_at: null,
              notified_unpinned_at: null,
            })
            .eq("cid", v.cid);
          results.push({
            cid: v.cid,
            action: "restored",
            received,
            delta,
            expires_at: extendedExpires,
            txid: stamp.txid,
          });
        } catch (err) {
          results.push({
            cid: v.cid,
            action: "restore_failed",
            error: String(err),
          });
        }
        continue;
      }
      // Track partial top-ups so the UI can show "renewal pending".
      if (received > prevReceived + 0.00000001) {
        await supabaseAdmin
          .from("videos")
          .update({ payment_received_txc: received })
          .eq("cid", v.cid);
      }
      results.push({
        cid: v.cid,
        action: "unpinned_waiting",
        received,
        needed: monthlyRate,
      });
      continue;
    }

    // Already-paid video: only update expires_at if more TXC arrived (top-ups extend life).
    if (v.paid_at) {
      try {
        const retriedTxid = await retryFailedPaymentStampForPaidVideo({
          cid: v.cid,
          owner_wallet: v.owner_wallet ?? "anon",
          video_wallet: v.video_wallet,
        });
        if (retriedTxid) {
          results.push({ cid: v.cid, action: "payment_restamped", txid: retriedTxid });
          continue;
        }
      } catch (err) {
        results.push({
          cid: v.cid,
          action: "payment_restamp_failed",
          error: String(err),
        });
        continue;
      }

      const prevReceived = Number(v.payment_received_txc ?? 0);
      if (received > prevReceived + 0.00000001) {
        await supabaseAdmin
          .from("videos")
          .update({
            payment_received_txc: received,
            expires_at: extendedExpires,
            // A top-up rescues a video from the expiring lifecycle.
            expiring_at: null,
            unpin_after: null,
            status: "active",
            notified_pre_expiry_at: null,
            notified_expiring_at: null,
          })
          .eq("cid", v.cid);
        results.push({
          cid: v.cid,
          action: "extended",
          received,
          expires_at: extendedExpires,
        });
        continue;
      }

      // --- Lifecycle for already-paid videos ---------------------------
      const expMs = new Date(v.expires_at).getTime();
      const title = v.title ?? v.cid.slice(0, 12);

      // 3a. Past unpin_after → actually remove from Pinata.
      if (
        v.unpin_after &&
        now > new Date(v.unpin_after as string).getTime()
      ) {
        try {
          const stamp = await recordChainEvent({
            cid: v.cid,
            videoWallet: v.video_wallet,
            eventType: "X",
            uploaderWallet: v.owner_wallet ?? "anon",
            extra: "expired",
          });
          await unpinByCid(v.cid);
          await supabaseAdmin
            .from("videos")
            .update({
              unpinned_at: new Date().toISOString(),
              status: "unpinned",
            })
            .eq("cid", v.cid);
          if (!v.notified_unpinned_at && v.owner_wallet) {
            await deliverAlert({
              wallet: v.owner_wallet,
              telegramText: `🗑️ <b>Video unpinned</b>\n<b>${title}</b> has been removed from IPFS storage because no renewal payment arrived during the 7-day grace.\n\nThe video's page and chain proofs are preserved. Pay any time to re-pin and restore it:\n${explorerVideoUrl(v.cid)}`,
              email: {
                templateName: "video-unpinned",
                templateData: {
                  title,
                  cid: v.cid,
                  videoUrl: explorerVideoUrl(v.cid),
                  manageUrl: manageUrl(),
                },
                idempotencyKey: `unpinned-${v.cid}`,
              },
            });
            await supabaseAdmin
              .from("videos")
              .update({ notified_unpinned_at: new Date().toISOString() })
              .eq("cid", v.cid);
          }
          results.push({ cid: v.cid, action: "lifecycle_unpinned", txid: stamp.txid });
        } catch (err) {
          results.push({
            cid: v.cid,
            action: "lifecycle_unpin_failed",
            error: String(err),
          });
        }
        continue;
      }

      // 3b. Just crossed expires_at → enter expiring grace.
      if (now > expMs && v.status !== "expiring" && v.status !== "unpinned") {
        const unpinAfter = new Date(now + POST_EXPIRY_GRACE_MS).toISOString();
        await supabaseAdmin
          .from("videos")
          .update({
            status: "expiring",
            expiring_at: new Date(now).toISOString(),
            unpin_after: unpinAfter,
          })
          .eq("cid", v.cid);
        if (!v.notified_expiring_at && v.owner_wallet) {
          await deliverAlert({
            wallet: v.owner_wallet,
            telegramText: `⚠️ <b>Video expiring in 7 days</b>\n<b>${title}</b> has reached its paid-through date. We'll keep it pinned for 7 more days, then remove the file from IPFS storage.\n\nRenew now to keep it online:\n${manageUrl()}`,
            email: {
              templateName: "video-expiring",
              templateData: {
                title,
                cid: v.cid,
                videoUrl: explorerVideoUrl(v.cid),
                manageUrl: manageUrl(),
                unpinAfter,
              },
              idempotencyKey: `expiring-${v.cid}`,
            },
          });
          await supabaseAdmin
            .from("videos")
            .update({ notified_expiring_at: new Date().toISOString() })
            .eq("cid", v.cid);
        }
        results.push({ cid: v.cid, action: "entered_expiring", unpin_after: unpinAfter });
        continue;
      }

      // 3c. Approaching expiry → 7-day heads-up.
      if (
        now < expMs &&
        expMs - now < PRE_EXPIRY_WARNING_MS &&
        !v.notified_pre_expiry_at &&
        v.owner_wallet
      ) {
        const daysLeft = Math.max(1, Math.ceil((expMs - now) / (24 * 3600 * 1000)));
        await deliverAlert({
          wallet: v.owner_wallet,
          telegramText: `⏰ <b>Heads-up:</b> <b>${title}</b> expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Renew anytime in Manage:\n${manageUrl()}`,
          email: {
            templateName: "video-expiry-warning",
            templateData: {
              title,
              cid: v.cid,
              daysLeft,
              expiresAt: v.expires_at,
              videoUrl: explorerVideoUrl(v.cid),
              manageUrl: manageUrl(),
            },
            idempotencyKey: `pre-expiry-${v.cid}`,
          },
        });
        await supabaseAdmin
          .from("videos")
          .update({ notified_pre_expiry_at: new Date().toISOString() })
          .eq("cid", v.cid);
        results.push({ cid: v.cid, action: "pre_expiry_warned", daysLeft });
        continue;
      }

      results.push({ cid: v.cid, action: "paid_noop", received });
      continue;
    }

    if (required > 0 && received >= required) {
      // PAID — stamp proof and activate.
      try {
        const stamp = await recordChainEvent({
          cid: v.cid,
          videoWallet: v.video_wallet,
          eventType: "P",
          uploaderWallet: v.owner_wallet ?? "anon",
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
          uploaderWallet: v.owner_wallet ?? "anon",
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
      // PAID — pin the comment JSON to IPFS, anchor its CID on chain,
      // split shares, activate.
      try {
        const { data: video } = await supabaseAdmin
          .from("videos")
          .select("video_wallet, hosting_credit_txc")
          .eq("cid", c.video_cid)
          .maybeSingle();
        const videoWallet = video?.video_wallet ?? c.deposit_wallet;

        // Pin a self-contained JSON record. Compact keys to keep it tiny.
        const pinned = await pinJsonToIPFS(
          {
            v: 1,
            kind: "comment",
            video: c.video_cid,
            amt: received.toFixed(8),
            ts: Math.floor(Date.now() / 1000),
            body: c.body,
          },
          `comment-${c.id}.json`,
        );
        const stamp = await stampCommentCid({
          commentCid: pinned.cid,
          amountTxc: received,
          videoWallet,
        });

        // Persist the chain trail.
        await supabaseAdmin.from("chain_events").insert({
          video_cid: c.video_cid,
          video_wallet: videoWallet,
          event_type: "M",
          tx_hash: stamp.txid,
          op_return_payload: stamp.payload,
          to_wallet: videoWallet,
          status: stamp.real ? "mempool" : "stamp_failed",
          metadata: {
            comment_id: c.id,
            comment_cid: pinned.cid,
          } as never,
        });

        const shares = splitShares(received);
        await supabaseAdmin
          .from("comments")
          .update({
            status: "active",
            paid_at: new Date().toISOString(),
            payment_received_txc: received,
            tx_hash: stamp.txid,
            op_return_payload: stamp.payload,
            comment_cid: pinned.cid,
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
          comment_cid: pinned.cid,
          tx: stamp.txid,
        });

        // Best-effort: sweep the 90/5/5 split immediately. If RPC is down
        // we'll have a row with payout_status='partial' and the owner can
        // hit "Retry payout" from /manage.
        try {
          const sweep = await sweepCommentPayout(c.id);
          results.push({
            comment_id: c.id,
            action: "sweep",
            sweep_status: sweep.status,
            sweep_details: sweep.details,
          });
        } catch (err) {
          results.push({
            comment_id: c.id,
            action: "sweep_failed",
            error: String(err),
          });
        }
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

        // Sweep the boost amount under the parent comment. The split goes
        // 90/5/5 the same way; recordSplitPayout writes its own S events.
        try {
          const sweep = await sweepBoostPayout(b.id, received, comment.video_cid);
          results.push({
            boost_id: b.id,
            action: "sweep",
            sweep_status: sweep.status,
            sweep_details: sweep.details,
          });
        } catch (err) {
          results.push({
            boost_id: b.id,
            action: "sweep_failed",
            error: String(err),
          });
        }
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