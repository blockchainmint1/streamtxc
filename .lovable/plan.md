## Goal

Stand up a parallel "v2" surface to test the MediaConvert → S3 → Pinata HLS pipeline without disturbing the live `/v/:cid` and `/upload` flows. Everything new lives at `/v2/:cid` and `/upload2` so we can iterate freely.

## 1. New player route: `/v2/:cid`

New file: `src/routes/v2.$cid.tsx`. Forks the current `/v/:cid` page but swaps the player for an enhanced `VideoPlayerV2`.

New file: `src/components/VideoPlayerV2.tsx`:
- HLS-first: prefers `hls_cid` (served via existing `/api/stream/$cid/$` route, e.g. `master.m3u8`), falls back to the legacy single-file CID.
- Quality selector built on `hls.levels` (Auto / 1080p / 720p / 480p / 360p), persists choice to `localStorage`.
- Playback speed menu (0.5x – 2x).
- Buffered / loading indicator overlay.
- Small "Source" badge showing `HLS` vs `MP4 fallback` and which gateway is serving.
- Keyboard shortcuts: space, ←/→ (5s), J/L (10s), M, F.

The `/v2/:cid` page also shows a small dev panel (only visible to the video owner or in dev) with: `transcode_status`, `transcode_job_id`, `transcode_started_at/completed_at`, `hls_cid`, `renditions`, and any `transcode_error`.

## 2. New upload route: `/upload2`

New file: `src/routes/upload2.tsx`. Fork of `/upload` with the new pipeline language and a visible stage tracker:

```text
1. Sign upload   →   2. Upload to S3   →   3. Register video
                                                   ↓
4. Pin original to IPFS   ←   5. Transcoding (MediaConvert)   →   6. Pinning HLS to IPFS   →   7. Done
```

Behavior:
- Step 1–3 use the existing AWS S3 signed-upload + `registerUpload` flow (already on `/upload-aws`).
- `registerUpload` is extended to set `transcode_status='pending'` and kick off MediaConvert when `AWS_MEDIACONVERT_ENDPOINT` is set; otherwise it stays `pending` and the UI shows "Transcoding queued (AWS not yet provisioned)".
- After register, the page polls `getTranscodeStatus({ videoId })` (new tiny server fn over the existing columns) every 4s and advances the stage tracker.
- On `transcode_status='complete'` the page auto-links to `/v2/:cid` and offers "Copy v2 link".
- Copy doesn't change `/upload` at all.

New language throughout: "Uploading to S3", "Transcoding (HLS, multi-bitrate)", "Pinning HLS directory to IPFS", "Re-anchoring metadata", "Ready to stream".

## 3. What else (small, high-leverage additions)

- **`/manage` badges**: add a `TranscodeBadge` next to each video row — Pending / Processing / Ready / Failed, with a "Retry transcode" action on Failed (server fn already exists or stub). Links the Ready badge to `/v2/:cid` so you can A/B against `/v/:cid`.
- **`getTranscodeStatus` server fn**: thin read-only fn used by both `/upload2` polling and `/manage` badges. No new tables.
- **`ipfsHlsUrl` helper verification**: short pass on `src/lib/ipfs-gateway.ts` to confirm `master.m3u8` resolution + add a unit-test-style runtime check exposed at `/v2/:cid` dev panel ("HLS playlist reachable: yes/no, X variants").
- **MediaConvert kickoff gating**: wrap the job-create call in `if (process.env.AWS_MEDIACONVERT_ENDPOINT)` so `/upload2` works end-to-end today (minus actual transcode) while the VPC limit increase is pending. The moment AWS comes back, no code change needed.

## Out of scope (explicit)

- No changes to `/v/:cid`, `/upload`, `/upload-aws`, or the webhook handler.
- No DB migrations — all columns already exist.
- No new auth/roles.

## Technical notes

- Files created: `src/routes/v2.$cid.tsx`, `src/routes/upload2.tsx`, `src/components/VideoPlayerV2.tsx`. Possibly `src/lib/transcode-status.functions.ts` if we don't extend `transcode.functions.ts`.
- Files touched: `src/routes/manage.tsx` (add badge column), `src/lib/transcode.functions.ts` (gate MediaConvert call on env var, add `getTranscodeStatus`).
- `/v2/:cid` reuses the existing public `getVideoByCid` loader pattern from `/v/:cid` for SSR + OG tags — share links remain crawlable.

## Open question

For `/upload2`, should the page **auto-redirect** to `/v2/:cid` when transcode completes, or just show a "Watch on v2" button and stay put so you can keep testing? Default in the plan above is "stay put, show button" — say the word if you want auto-redirect.
