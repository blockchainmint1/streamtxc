## Duplicate CID Detection

Since CIDs are content-addressed, the same video file always produces the same CID — which makes duplicate detection trivial and bulletproof. We just check the DB before stamping/pinning.

### Where duplicates can enter

1. **`/upload` direct file upload** — user uploads a file we've seen before (post-Pinata, we know the CID).
2. **"Add by CID"** flow — user pastes a CID claiming ownership of someone else's already-stamped video.
3. **Race condition** — two users uploading the same file simultaneously.

### Detection logic

Before calling `stampCid` + inserting into `videos`, run:
```sql
SELECT cid, owner_wallet, title, created_at, tx_hash
FROM videos WHERE cid = $1 LIMIT 1;
```

If a row exists → block with a friendly error showing:
- Original uploader wallet (truncated)
- Original upload date
- Link to existing `/v/{cid}` page
- TXC tx hash as proof of prior claim

### UX per flow

**Direct upload (`/upload`)**:
After Pinata returns the CID but **before** we call `registerUpload`, check duplicates. If found, show a toast: *"This video was already published on stream by `tx1q3k...8z` on May 8, 2026. [View original →]"* — and skip stamping (no chain spam, no second pin from us).

**Add by CID**:
Same check inside `addByCid` server fn. Throw a structured error the client renders inline: *"Nice try 😏 — this CID is already claimed."* with link to the original.

**Race condition**:
Add a `UNIQUE` constraint on `videos.cid` (DB migration). Even if two requests pass the duplicate check simultaneously, the second `INSERT` fails. Catch the unique-violation error and return the same friendly response.

### Pinata-side dedup (bonus)

Pinata itself dedups pins by CID across our account, so re-pinning costs nothing storage-wise. But we still want to reject early so:
- We don't spam OP_RETURN txs for already-stamped CIDs
- We don't double-charge in the future payment flow
- The DB stays clean (one row per CID)

### Optional: "claim" vs "republish"

Edge case — what if user A uploaded a video, then user B legitimately uploads the *same* file (e.g. a public domain clip)? Two reasonable policies:

- **Strict (recommended for MVP)**: First wallet to stamp wins. Period. Matches "proof of first publication" semantics that the on-chain stamp implies.
- **Permissive**: Allow multiple `videos` rows per CID with different wallets, show all claimants on the `/v/{cid}` page sorted by stamp time.

I'd ship **strict** for now — it's simpler, matches the on-chain story, and prevents drive-by claim-jacking. We can relax later if needed.

### Files to touch

- **Migration**: `ALTER TABLE videos ADD CONSTRAINT videos_cid_unique UNIQUE (cid);`
- **`src/lib/videos.functions.ts`**: add duplicate check at top of `registerUpload` and `addByCid`; catch unique-violation on insert.
- **`src/routes/upload.tsx`**: handle the new `DUPLICATE_CID` error response — show a clean inline message with the original uploader info and a link to `/v/{cid}` instead of erroring out.
- **(optional)** `src/components/DuplicateNotice.tsx`: small reusable component for the "already exists" panel.

### What ships

Try to upload or claim a CID that's already on the platform → instant friendly rejection with proof of who got there first. No wasted on-chain stamps, no duplicate DB rows, no claim-jacking.
