# Wallet ownership + 90/5/5 comment payouts

## The problem in one paragraph

Today `videos.owner_wallet` is just a string the uploader types — there's no proof they actually control it, so we can't safely send them 90% of comment revenue. Comment funds also currently land in a per-comment deposit wallet and never move. We need (1) hard proof of wallet control at upload time, and (2) a sweeper that splits each confirmed comment payment 90/5/5 the moment it confirms.

## Approach

**Ownership = sign-a-challenge + on-chain attestation, required at upload.** The user supplies a TXC wallet, the server returns a one-time nonce, the user signs it with their wallet (browser extension or pasted signature). On valid signature we stamp a new `O` (ownership) OP_RETURN tying the CID ↔ wallet on-chain. No verified signature → no upload. This satisfies "prove immediately" without waiting for real on-chain payments and gives us a public, immutable record.

**Payouts = immediate sweep on confirmation, three on-chain txs per paid comment.** When the per-comment deposit wallet's payment confirms, we send 5% → platform, 5% → hosting wallet, 90% → the verified owner wallet, in three separate TXC txs. Non-custodial, simple, matches your "sweep immediately" choice.

## On-chain protocol additions

Extend the OP_RETURN tag set in `src/lib/txc.server.ts`:

```text
O  ownership   TXCV1O|<videoCid>|<ownerWallet>|<nonce>   stamped after sig verifies
S  split       TXCV1S|<commentCid>|<creator|hosting|platform>|<amountTxc>
                                                          stamped on each payout leg
```

`C`, `T`, `M`, `B` stay as-is. Every `S` event is recorded in `chain_events` so the watch page can show the full money trail per comment.

## Database changes

`videos`:
- `owner_proof_status text not null default 'unverified'` — `unverified | verified`
- `owner_nonce text` — random nonce we issued for verification
- `owner_signature text` — the sig the user returned
- `owner_verified_at timestamptz`
- `ownership_tx_hash text` — txid of the `O` stamp

`comments`:
- `payout_status text not null default 'pending'` — `pending | swept | failed`
- `creator_payout_tx_hash text`
- `hosting_payout_tx_hash text`
- `platform_payout_tx_hash text`

New secret: `TXC_HOSTING_ADDRESS` (the wallet that receives the 5% hosting share). `TXC_PLATFORM_ADDRESS` already exists.

## Upload flow (new)

1. `/upload` — user enters TXC wallet → calls `getOwnershipChallenge({ wallet, cid })` → server stores nonce, returns the message to sign:
   `texitcoin-stream ownership v1\nwallet=<wallet>\ncid=<cid>\nnonce=<nonce>\nts=<iso>`
2. User signs (TXC wallet extension if available, else paste-signature fallback). Server verifies via standard ECDSA recovery against `wallet`.
3. On success: server stamps `O` on chain, then proceeds with the existing `C` + `T` stamps and inserts the `videos` row with `owner_proof_status='verified'`.

If signature fails or the user cancels, the upload is rejected — no row, no IPFS pin promotion.

## Comment payout sweeper

Add a `sweepCommentPayout(commentId)` server fn called from the existing comment-confirmation poller (the same place `status` flips to `active`):

```text
amount = comment.payment_received_txc
creator  = round(amount * 0.90, 4)   → owner_wallet
hosting  = round(amount * 0.05, 4)   → TXC_HOSTING_ADDRESS
platform = amount - creator - hosting → TXC_PLATFORM_ADDRESS  (absorbs rounding dust)
```

For each leg: build + broadcast tx from the per-comment deposit wallet, store the txid on the `comments` row, write an `S` `chain_events` row. If any leg fails, mark `payout_status='failed'` and surface in /manage; a retry button re-sweeps only the missing legs.

If `owner_proof_status != 'verified'` (which shouldn't happen for new uploads, but might for the 11 legacy rows): the sweeper rejects the comment intent before payment is taken.

## Backfill for the 11 existing videos

One-time `/manage` banner: "Verify wallet ownership to keep accepting comments." Same sign-a-nonce flow, same `O` stamp. Until verified, `createCommentIntent` returns a friendly "creator hasn't verified ownership yet" error.

## UI changes

- `/upload`: wallet field becomes required + a "Verify wallet" step (button → modal with the message + signature input or auto-sign via wallet extension) before the file actually starts uploading to Pinata.
- `/manage`: badge per video — green "Verified owner" or amber "Unverified — verify now". Show payout history per comment with explorer links to all 4 txs (initial + 3 splits).
- Watch page (`/v/$cid`): a small "Verified creator" check next to the wallet, plus a "Where the money went" expandable on each paid comment showing the three split txids.

## Implementation order

1. **Migration** — add the new columns + chain-event `O` and `S` types are just new strings, no schema change there.
2. **`txc.server.ts`** — add `stampOwnership()` and `stampSplit()` helpers; add a `verifySignature(message, signature, wallet)` helper using ECDSA recovery.
3. **`videos.functions.ts`** — `getOwnershipChallenge`, modify `registerUpload` to require + verify signature and stamp `O` before insert.
4. **`comments.functions.ts`** — block intent creation when owner unverified; add `sweepCommentPayout` and call it from the confirmation path.
5. **Upload UI** — wallet + verify step.
6. **Manage UI** — verification banner + payout history.
7. **Backfill prompt** for the 11 legacy videos.

## Open questions for you

- **Hosting wallet**: do you want a fresh TXC address generated and stored as `TXC_HOSTING_ADDRESS`, or should the 5% hosting share just be added to `videos.hosting_credit_txc` (kept in the per-video wallet) and only swept out when the video renews? The second is cheaper (1 fewer tx per comment) but means hosting funds stay tied to each video instead of pooling.
- **Signature method**: do TXC wallets have an injected browser provider (like MetaMask's `window.ethereum`) we can call for `personal_sign`, or do we need to ship a paste-the-signature fallback only? This decides how friendly the verify step looks.
