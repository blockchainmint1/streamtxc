## Add comments-by-wallet to `/u/$wallet`

Extend the channel page to show a second section listing all comments that wallet has posted across the platform, alongside their videos.

### 1. New server fn `listCommentsByWallet` (`src/lib/comments.functions.ts`)
- Public, POST.
- Input: `{ wallet: string }` (zod, min 1 max 200).
- Query `comments` where `commenter_wallet = wallet`, `status = 'active'`, `hidden_at is null`, order `created_at desc`, limit 100.
- Select: `id, body, video_cid, initial_payment_txc, boost_total_txc, last_boost_at, created_at, tx_hash, comment_cid`.
- Map to add `explorerUrl` and `ipfsUrl` (same shape as `listComments`).
- Also join in the parent video's title for context: do a second query against `videos` for the distinct `video_cid`s, select `cid, title`, and merge `videoTitle` onto each row. (Two queries — Supabase JS doesn't do FK-less joins, and there's no FK on `comments.video_cid`.)

### 2. Update `/u/$wallet` route (`src/routes/u.$wallet.tsx`)
- Loader: call both `listVideosByOwner({ wallet })` and `listCommentsByWallet({ wallet })` in parallel via `Promise.all`, return `{ videos, comments }`.
- Render two sections under the channel header:
  - **Videos** (existing grid, unchanged).
  - **Comments** — new section below. For each comment: body (truncated to ~280 chars with "…"), small meta row with `last_boost_at` relative time, `boost_total_txc` if > 0, and a `<Link to="/v/$cid">` showing the parent video title (fallback to short CID if title missing). Each comment card links to `/v/$cid` (the comment lives on the video page).
  - Empty states for each section ("No videos yet" / "No comments yet"). If both empty, show a single combined empty state.
- Keep section headings consistent with existing typography on the page.

### Out of scope
- Pagination (100-row cap is fine for now).
- Linking commenter wallets in `Comments.tsx` on the video page (separate ask).
- Deep-linking to the specific comment within the video page (no anchor support today).
- Showing boosted-by-this-wallet comments — only authored comments.