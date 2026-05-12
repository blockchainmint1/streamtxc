## Bulk +30-day extension — copy-pasteable `sendmany`

Add a "Bulk extend +30 days" action on `/manage` that gathers every video the connected wallet owns, computes the per-video TXC fee for one extra month, and returns a ready-to-paste `sendmany` command for your web wallet. Nothing is broadcast from the server.

### User flow

1. On `/manage`, a new button next to "Upload your first" / table header: **`Extend all +30d`**.
2. Click → modal opens showing:
   - Per-video table: title · deposit address · TXC amount
   - Total TXC + USD estimate
   - A monospace text block with the full CLI command, plus a "Copy" button
   - A "Mark as paid" button (optional second step — see below)
3. Paste into TXC web wallet → broadcast → done.

### Server function — `buildBulkExtendQuote`

New server fn in `src/lib/videos.functions.ts`:

- Input: `{ wallet, months: 1 }`
- Loads every video where `owner_wallet = wallet` and `video_wallet IS NOT NULL` (covers all your videos regardless of status, per your answer)
- For each video, computes fee using existing `quoteUsd(size_bytes, months)` + `usdToTxc()` with current `getTxcUsdPrice()`
- Returns:
  ```ts
  {
    txcUsd: number,
    totalTxc: number,
    totalUsd: number,
    items: Array<{ cid, title, depositAddress, txcAmount }>,
    sendmanyJson: string,    // '{"addr1":1.234,"addr2":5.678}'
    sendmanyCli: string,     // full command (see below)
  }
  ```

### `sendmany` format

Standard Bitcoin/Litecoin RPC shape (TXC inherits this):

```
texitcoin-cli sendmany "" '{"<addr1>":1.23456789,"<addr2>":0.98765432}'
```

The first arg `""` is the "fromaccount" (legacy, empty string = default). Amounts are TXC, max 8 decimals. We round each fee to 8dp.

Tell me if your web wallet expects a different invocation (e.g. just the JSON object, or `sendmany` with no `""`, or comment/subtractfee args) and I'll adjust the formatter.

### Recording the extension

Two options to discuss before I build — pick one in your next message:

- **A) Server-side stamp after paste.** Add a "Mark as paid" button that, when clicked, bumps `expires_at += 30 days` for each video, inserts `payments` rows, and (optionally) records an `E` (extend) chain event per video using `recordChainEvent` so there's an on-chain audit trail. Trust-based — nothing verifies the TX actually went through.
- **B) Watcher-driven.** Don't touch the DB on click. Let the existing `payment-watcher` route detect the new deposits at each `video_wallet`, credit them, and bump `expires_at`. Requires the watcher to know about extension semantics (currently it handles initial payment).

A is faster to ship; B is more correct. I'd suggest A now, B later.

### UI changes

- `src/routes/manage.tsx`: add `BulkExtendDialog` component with table, total, copy button, and (if A) confirm button calling `markBulkExtended` server fn.
- New action button in the page header above the videos table.

### Files to add / edit

- `src/lib/videos.functions.ts` — add `buildBulkExtendQuote` (and `markBulkExtended` if A)
- `src/routes/manage.tsx` — add button + dialog

### Open questions

1. Confirm the `sendmany` syntax above matches your web wallet, or paste the exact format.
2. A or B for recording the extension?
