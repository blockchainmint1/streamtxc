## Goal

Replace the mock on-chain stamp with a **real TXC OP_RETURN transaction** anchoring each upload's CID + uploader wallet on the TXC blockchain. Skip user payments for now (free tier). Watch the mempool for confirmation and update the UI live.

## Architecture

```text
Upload finishes (Pinata returns CID)
        │
        ▼
registerUpload() server fn
        │
        ├─ INSERT video row (status='stamping')
        ├─ POST to TXC node RPC: build + sign + broadcast OP_RETURN tx
        │     OP_RETURN payload: "TXCV1" + cid + ":" + wallet (≤80 bytes)
        ├─ Save txid on row (status='mempool', block_number=null)
        └─ Return { cid, txid }
        ▼
Watch page /v/$cid
        │
        ├─ Shows "⏳ In mempool — txid abc123…" with link to mempool.texitcoin.org
        └─ useQuery polls /api/public/tx-status/$txid every 15s
                │
                ▼
        Server fn hits mempool.texitcoin.org/api/tx/{txid}
                │
                ├─ unconfirmed → keep polling
                └─ confirmed → UPDATE videos SET status='active',
                                  block_number=X, block_hash=Y
                              → UI flips to "✓ Confirmed in block #X"
```

## What we need from you (one-time setup)

1. **Spin up a TXC hot wallet** for the platform. Fund it with a small amount of TXC (enough for ~10,000 OP_RETURN txs at network fee — probably <1 TXC).
2. **Give us node RPC access**, ideally one of:
   - **Preferred:** A Bitcoin-style JSON-RPC endpoint (`https://node.texitcoin.org` + RPC user/pass) supporting `createrawtransaction`, `signrawtransactionwithwallet`, `sendrawtransaction`. This is what `bitcoind`/`litecoind` exposes by default.
   - **Acceptable:** A hosted wallet API at `wallet.texitcoin.org` with an endpoint that accepts "send X to address Y with OP_RETURN data Z" and returns a txid.
3. We'll store the credentials as secrets: `TXC_RPC_URL`, `TXC_RPC_USER`, `TXC_RPC_PASS`, `TXC_PLATFORM_ADDRESS`.

If the RPC details aren't ready yet, we can still build everything with a clearly-marked stub adapter (`txc.server.ts`) and swap the implementation in one place once you give us credentials.

## Files we'll change

- **`src/lib/txc.server.ts`** *(new)* — single adapter with two functions:
  - `stampCid({ cid, wallet, sizeBytes })` → builds + broadcasts OP_RETURN tx, returns `{ txid }`
  - `getTxStatus(txid)` → calls `mempool.texitcoin.org/api/tx/{txid}` and returns `{ confirmed, blockHeight?, blockHash? }`
- **`src/lib/chain.ts`** — replace mock with calls to `txc.server.ts` (keep the same interface so callers don't change).
- **`src/lib/videos.functions.ts`** — `registerUpload` now calls real `stampCid`; add `pollTxStatus` server fn for the watch page.
- **DB migration** — add columns to `videos`:
  - `op_return_payload text` (the exact bytes we wrote, for audit)
  - `block_hash text` (in addition to existing `mock_block_number` which we'll rename to `block_number`)
  - Rename `mock_tx_hash` → `tx_hash`. Statuses: `stamping | mempool | active | failed`.
- **`src/routes/v.$cid.tsx`** — On-chain proof panel:
  - Pending state: spinner + "In mempool" + link to `mempool.texitcoin.org/tx/{txid}`
  - Confirmed state: green check + block number + block hash + same explorer link
  - `useQuery` with 15s `refetchInterval` while `status='mempool'`.
- **`src/routes/upload.tsx`** — On success, redirect straight to `/v/{cid}` so user sees the live confirmation flow.

## OP_RETURN payload format

Keep it under 80 bytes (TXC default `OP_RETURN` data limit, same as Bitcoin):

```
TXCV1|<cid>|<short-wallet>
```

Example: `TXCV1|bafybeibo...wyq|tx1q3k...8z` — ~70 bytes for a CIDv1 + bech32-style address. If a CID + wallet exceed 80 bytes we fall back to `TXCV1|<sha256(cid+wallet) as hex>` and store the preimage in DB.

## Mempool-based UX (your idea, fully adopted)

- The moment `sendrawtransaction` returns a txid, we mark the video **viewable** (status `mempool`).
- The watch page shows it immediately with a "⏳ Pending confirmation" badge.
- Polling flips the badge to "✓ Confirmed" within ~1 block (typically 1–10 min depending on TXC block time).
- No user-blocking wait anywhere — they upload, they watch, the proof firms up in the background.

## Out of scope (deferred)

- **User payments / fee collection** — explicitly free for now per your call. When the wallet UX is ready we'll add an `invoice` step that watches the mempool for a payment from the uploader's wallet to ours, then unpins on non-payment. The `pins` table and `expires_at` column already exist for this.
- **Reorg handling** — if a confirmed tx gets re-orged out we won't auto-revert. Vanishingly rare on a chain with any hashrate; can add later.
- **Batching** — every upload posts its own tx. If volume gets high we can batch CIDs into Merkle roots (OpenTimestamps-style) and stamp one tx per minute. Not needed at MVP scale.

## What ships

Every video uploaded gets a real, verifiable TXC blockchain transaction whose `OP_RETURN` data permanently anchors `(cid, owner_wallet)`. Anyone can independently verify ownership by looking up the txid on `mempool.texitcoin.org` and reading the OP_RETURN bytes — no trust in our platform required. That's the whole point.