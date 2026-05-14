## What's happening

Your wallet `txc1qa8w…ntr` (video "Bobby's Goofy Disclaimer", CID `QmZj4N…6c3N`) has received **30.0003 TXC** total across 4 funding txs. Required to renew was **7.859 TXC**, so you're paid up ~3.8x over.

The reason it still shows "payment due / expired":

`processVideos()` in `payment-watcher.ts` filters with `.is("unpinned_at", null)`. Once a video is unpinned, the watcher stops looking at its wallet entirely — so any later payment is invisible to the system. Combined with the earlier bug where `restoreUnpinnedVideos` flips `status='active'` without clearing `unpinned_at`, the row is in a weird middle state: marked active, but excluded from the watcher.

## Plan

Scope: payment-watcher only. UI/restore overlay is the previous plan.

### 1. Watcher: handle unpinned videos as a renewal path

In `src/routes/api/public/hooks/payment-watcher.ts → processVideos()`:

- Drop the `.is("unpinned_at", null)` filter. Select unpinned rows too.
- Add a new branch *before* the existing `paid_at` / `paid` / `grace` branches:

  ```text
  if (v.unpinned_at != null) {
    received = getAddressReceived(wallet)
    delta    = received - payment_received_txc
    if (delta >= monthlyRate)  // at least 1 month of new funds since takedown
      → re-pin via pinByCid(cid)
      → probe gateway (HEAD, ~3s)
      → if probe ok:
          stamp "R" (renewal) OP_RETURN with delta
          update videos: unpinned_at=null, status='active',
                         paid_at=COALESCE(paid_at, now()),
                         payment_received_txc=received,
                         expires_at = created_at + (received/monthlyRate)*30d
          result: { action: 'restored', received, delta, expires_at }
        else:
          result: { action: 'restore_pin_unavailable' }  // leave row unpinned
    else:
      result: { action: 'unpinned_waiting', received, needed: monthlyRate }
  }
  ```

  This makes a payment to an expired video's wallet automatically re-pin and reactivate it, with on-chain proof. No manual intervention.

- Existing `paid_at` (top-up extension), fresh-paid, grace-expired, and waiting branches remain unchanged for `unpinned_at IS NULL` rows.

### 2. Backfill the one stuck row

After the deploy, the watcher's next tick will see `QmZj4N…6c3N` has 30.0003 TXC vs 7.859 required and:
- re-pin from Pinata by CID (Pinata keeps the CID record; if peers still hold it, it comes back; if not, the probe fails and we surface that)
- stamp R, set `unpinned_at=null`, `status='active'`, `expires_at ≈ created_at + (30.0003/7.859)*30d ≈ created_at + 114 days`

No manual SQL needed if the re-pin probe succeeds. If the probe fails (file genuinely gone from IPFS), the row stays unpinned and the owner re-seed flow from the previous plan kicks in — but the payment is now tracked, so the re-seed only has to upload bytes, not also pay again.

### 3. UI: show "renewal pending" vs "expired"

In `/u/<wallet>` (and the video page overlay from the prior plan), when `unpinned_at IS NOT NULL` AND `payment_received_txc - (paid amount baseline) >= monthlyRate`, label as **"Renewal received — restoring…"** instead of **"Expired"**. Cosmetic; one extra branch in the existing badge logic.

### Files to edit

- `src/routes/api/public/hooks/payment-watcher.ts` — drop filter, add unpinned-renewal branch
- `src/lib/pinata.server.ts` — re-export `pinByCid` if not already exported
- `src/routes/u.$wallet.tsx` — add "renewal pending" badge state

### Out of scope

- The video-page overlay + owner re-seed flow (covered by the previous approved plan, partially implemented)
- Reconciling other inconsistent rows (we'll let the watcher heal them naturally on next tick)
- Refunding overpayment — the extra ~22 TXC on this wallet just buys ~85 extra days of hosting via the existing `expires_at` formula
