## Goal

When a video's underlying IPFS content can't be served (unpinned, gateway 404, restore-from-IPFS didn't actually find peers), the watch page should clearly say so and give the owner a fast path to re-seed the **same CID** without re-doing wallet, title, description, payment address, or pricing.

## Two problems to solve

1. **Detection is unreliable today.** `videos.status` and `unpinned_at` get out of sync. The example CID `QmZj4...c3N` shows `status='active'` *and* `unpinned_at IS NOT NULL` — likely a side-effect of the Restore-from-IPFS button flipping status without verifying the file came back. The UI trusts `status` and shows a normal player that just spins.
2. **No re-seed path.** The only recovery is a brand new upload, which mints a new CID, new video_wallet, new pricing quote, and breaks every existing share link / on-chain record.

## Plan

### 1. Truthful availability signal

- Add a server fn `probeAvailability({ cid })` that does a **HEAD** request against our Pinata gateway (`gatewayUrl(cid)`) with a short timeout (~3s). Returns `{ available: boolean, checkedAt }`.
- Call it from `/v/$cid` via `useQuery` with `staleTime: 60_000` after the main `getVideo` resolves. Don't block first paint.
- Treat the video as unavailable when **either** `unpinned_at IS NOT NULL` **or** the live probe fails. This makes the UI honest even when `status` is stale.
- Fix the inconsistent state going forward: the Restore-from-IPFS server fn should **not** clear `unpinned_at` or change `status` until a probe confirms the bytes are actually fetchable. Add a follow-up cron pass (or check inside `restoreUnpinnedVideos`) that probes each CID a few minutes after queuing the pin, and only then flips `unpinned_at = null` + `status = 'active'`.

### 2. "Video no longer on IPFS" overlay on `/v/$cid`

- Replace the player with an overlay card when unavailable:
  - Headline: "This video is no longer available on IPFS."
  - Sub: "The hosting prepayment expired and our pinning node released the file. The on-chain record is permanent — the file just isn't being seeded anymore."
  - Primary CTA (visible to everyone): **"Try to restore from IPFS peers"** → calls existing `pinByCid` for this single CID, then re-probes after a few seconds and reloads on success.
  - Secondary CTA (gated to `owner_wallet`): **"Re-seed this video"** → opens the re-seed flow (see §3).
  - Tertiary link: external IPFS gateway link (`https://ipfs.io/ipfs/<cid>`) so the owner can verify themselves.
- Below the overlay, keep title, description, owner, comments, on-chain stamps visible — only the player area is replaced.

### 3. Owner re-seed flow (`/v/$cid/restore`)

Re-seed = "I still have the original file. Re-upload it; if its CID matches the existing record, re-pin it and clear the unpinned flag." This is fundamentally different from a fresh upload because **everything except the bytes already exists**.

UI (new route `src/routes/v.$cid.restore.tsx`):
- Wallet gate: must be connected as `owner_wallet`. Sign a short challenge so the server can verify ownership (same pattern as the existing owner verification).
- Drag-and-drop dropzone (reuse the new dropzone component from the upload page) with a single file picker. No title / description / pricing fields — pulled from the existing row, shown read-only above the dropzone for confirmation.
- Client-side: `computeCids(file)` to get the candidate CID, compare against `video.cid` before uploading. If mismatch → hard stop: "This file's CID is `bafy…xyz`, which doesn't match the original `Qm…c3N`. You need the exact original file." (Offer a "Upload as a new video" link to `/upload` as fallback.)
- If match: stream to a new server fn `reseedVideo` (POST). Server fn:
  1. `requireWalletSignature` — verify the connected wallet equals `owner_wallet`.
  2. Re-run `computeCids` on the received bytes server-side and reject if it doesn't equal the row's `cid`.
  3. Call `pinFileToIPFS(file, originalFilename)` — Pinata dedupes by CID, so this just re-pins the existing CID into our account.
  4. Probe the gateway to confirm fetchable.
  5. Update the row: `unpinned_at = null`, `status = 'active'`. Leave `expires_at` alone — renewal payment is a separate concern (the `/u/<wallet>` renewal banner already handles it). If `expires_at` is in the past, surface a warning on success: "Re-seeded, but hosting expires in X. Renew to keep it pinned."
  6. Stamp a new chain event (`event_type = 'R'` for re-seed) so the timeline reflects what happened.
- Toast + redirect back to `/v/$cid` on success.

### 4. Tighten the "expired" UI on `/u/<wallet>`

Currently it filters on `status = 'unpinned'`, which misses rows like our example where status got flipped back. Change the expired-count + EXPIRED badge to use `unpinned_at IS NOT NULL OR availability-probe-failed` instead. (Probe is too expensive per-card on the listing — easiest is to trust `unpinned_at` here and let the watch page do the live probe.)

## Files

- `src/lib/videos.functions.ts` — add `probeAvailability`, `reseedVideo`; tighten `restoreUnpinnedVideos` to not flip status until verified.
- `src/routes/v.$cid.tsx` — add availability probe query + overlay card replacing the player when unavailable.
- `src/routes/v.$cid.restore.tsx` — new route, owner-gated re-seed dropzone.
- `src/routes/u.$wallet.tsx` — switch expired filter from `status=='unpinned'` to `unpinned_at != null`.
- `src/lib/pinata.server.ts` — small helper `headCidOnGateway(cid)` for the probe.

## Out of scope (call out, don't build)

- Auto-marking videos unavailable across the whole site via a periodic probe sweep. We can add this later as a cron pass; for now the per-page probe is enough.
- Renewal payments — already covered by the existing `/u/<wallet>` sendmany flow.
- Reconciling the inconsistent rows that already exist (status='active' + unpinned_at set). Once §1 is in, the watch page will tell the truth about them; a one-shot SQL cleanup can follow.
