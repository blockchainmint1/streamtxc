## Bug fixes & small features

### 1. Fix price copy on upload page

Two stale `$0.01 / MB / month` strings — current rate is `$0.001`.

- `src/lib/fees.ts` line 2 — comment header.
- `src/routes/upload.tsx` line ~518 — visible "what you'll pay" blurb.

Both → `$0.001 / MB / month`. (Verified against `RATE_USD_PER_MB_PER_MONTH = 0.001` in `fees.ts`.)

### 2. Homepage: 9 videos, sort + load more

Update `listRecentVideos` in `src/lib/videos.functions.ts` to accept `{ sort, limit, offset }` and return `{ items, total }`:

- `newest` → `order created_at desc` (current default)
- `expensive` → `order payment_required_txc desc nulls last`
- `comments` → join/aggregate comment count per video (one extra query: `from('comments').select('video_cid', { count: 'exact', head: false })` grouped, or a small RPC; simpler: select all active comment `video_cid`s and tally in JS — fine at current scale)
- `leaving-soon` → `order expires_at asc` (active only)

Update `src/routes/index.tsx`:

- Default page size 9, default sort `newest`.
- Sort tabs/segmented control above the grid: **Newest · Most expensive · Most comments · Leaving soon** (font-mono, matches header style).
- "Load more" button below the grid that increments offset by 9 and appends results (use `useState` for accumulated list + `useQuery` keyed by sort, reset on sort change). Hide button when `items.length >= total`.

### 3. New `/about` explainer page

Create `src/routes/about.tsx` with its own `head()` (unique title/description/og). Add an "about" link in `src/components/Header.tsx` next to upload/manage.

Content sections (full-transparency, blockchain-proof angle):

1. **Hero** — "Video you actually own" + one-line pitch.
2. **What it is** — upload → IPFS pin → CID → on-chain TXC stamp → stream by hash forever.
3. **Why it's built this way** — 4 cards:
   - *Immutable filenames* — the CID is the file; if bytes change, the address changes. No silent re-edits.
   - *On-chain receipts* — every payment, comment, and boost is an OP_RETURN on TXC. Public, permanent, auditable.
   - *No platform middleman* — no account, no algorithm, no takedown. You pay the network for storage; the network keeps it.
   - *Pay what it costs* — $0.001/MB/month in TXC. Views earn the creator credits; popular videos pay for their own pinning.
4. **How a video flows** — short numbered diagram (upload → CID → pay → stamp → stream / embed).
5. **What's verifiable** — list with explorer + IPFS gateway links (using existing helpers `explorerTxUrl`, Pinata gateway domain).
6. **FAQ** — 4–5 short Qs: *Who hosts it? What if I stop paying? Can I delete it? Is this censorship-resistant? Why TXC?*
7. CTA strip → Upload / Browse.

Style: re-use the existing aesthetic from `index.tsx` (mono labels, `var(--gradient-primary)` accents, bordered grid cards). No new dependencies.

### Out of scope

- No DB schema changes.
- No changes to upload pricing logic itself (already correct, just the label is wrong).
- No new comment-count column — computed at query time for now.
