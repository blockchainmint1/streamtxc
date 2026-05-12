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
import { getAddressReceived } from "@/lib/txc.server";
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
  const { data: pending, error } = await supabaseAdmin
    .from("videos")
    .select(
      "cid, owner_wallet, video_wallet, payment_required_txc, months_prepaid, created_at, paid_at, expires_at, payment_received_txc",
    )
    .is("unpinned_at", null)
    .not("video_wallet", "is", null)
    .limit(100);

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
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

  return Response.json({ ok: true, scanned: pending?.length ?? 0, results });
}