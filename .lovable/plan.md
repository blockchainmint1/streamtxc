
# video.texitcoin.org — MVP Plan

A loginless, wallet-authenticated video platform. Upload an MP4, pay TXC by file size, get a CID timestamped on-chain, stream via HLS through our gateway, embed anywhere, earn rewards as views accrue.

## Core flow

```text
[Uploader]
   │  1. Connect wallet, drop MP4
   ▼
[Web app]  ── 2. Quote fee (size × rate) ──> [Wallet signs TXC payment (mocked)]
   │
   │  3. Upload to our transcode worker
   ▼
[Transcode worker]  ── ffmpeg → HLS (360p/720p/1080p) ──> [Pinata pin]
   │                                                          │
   │  4. Get root CID                                          │
   ▼                                                          ▼
[TXC chain]  ◄── 5. Timestamp { cid, wallet, size, ts } ──  (mocked)
   │
   ▼
[Gateway]  stream.video.texitcoin.org/{cid}/index.m3u8
   │  - proxies IPFS, logs every segment request → views
   │  - enforces pin lifecycle (active / expiring / unpinned)
   ▼
[HLS.js player]  embeddable iframe with mute / autoplay / start / size
```

## Pages (TanStack Start routes)

- `/` — Landing: pitch, "Upload a video" CTA, featured videos.
- `/upload` — Wallet connect → file picker → fee quote → pay → progress.
- `/v/$cid` — Watch page: player, title, uploader wallet, on-chain timestamp link, view count, IPFS CID, embed code generator.
- `/manage` — Wallet-gated dashboard: list of videos owned by connected wallet, credits remaining, expiry warnings, top-up button.
- `/embed/$cid` — Bare iframe target (no chrome) with query params `?mute=1&autoplay=1&t=42`.
- `/api/upload` — Receives MP4 + payment proof; enqueues transcode job.
- `/api/stream/$cid/$` — Gateway proxy for `.m3u8` and `.ts` segments; logs views.
- `/api/quote` — `{ sizeBytes } → { txcAmount, expiresAt }`.

## Technical details

**Stack additions**
- `hls.js` — player.
- `@pinata/sdk` — pinning (server-side; JWT in secrets).
- `wagmi` + `viem` — wallet connection (EVM-style; we'll target whatever TXC exposes; mocked for now).
- `zod` — validation.
- Lovable Cloud (Supabase) — metadata store: `videos`, `view_events`, `payments`, `pins`.

**Transcoding worker (out of scope for the Worker SSR runtime)**
ffmpeg won't run inside the Cloudflare Worker. We need an external worker:
- v1 mock: a stub `/api/upload` that accepts the file, fakes a 30s "transcoding" delay, pins the *original MP4* to Pinata, and writes a single-rendition `index.m3u8` pointing at the MP4. Lets the entire UX work end-to-end while we provision real transcoding.
- v1.1 real: small Node service on a VPS (Hetzner ~$5/mo) running ffmpeg + a Redis queue, called over HTTPS from `/api/upload`. Out of scope for this build but the contract is defined.

**Playback gateway (`/api/stream/$cid/$`)**
- Streams from Pinata's dedicated gateway with `Range` support.
- Rewrites segment URLs in `.m3u8` to stay on our domain.
- Logs each `.ts` segment fetch (debounced per IP+CID per 30s) → `view_events`.
- View = N segments fetched (e.g. ≥3) to filter scrubs/bots.

**On-chain timestamping (mocked)**
- `chain.ts` module with one function `timestampCid(cid, wallet, sizeBytes) → { txHash, blockNumber, explorerUrl }`.
- v1 returns a deterministic fake hash + a placeholder explorer URL.
- Swap implementation later when TXC RPC is ready; rest of app unchanged.

**Wallet & payment (mocked)**
- wagmi connect modal (MetaMask injected provider works for any EVM-compatible chain).
- `payForUpload({ amount })` returns mock tx hash; persisted to `payments` table as proof.
- Real implementation slot is identical: `wallet.sendTransaction(...)`.

**Pricing & lifecycle**
- Quote: `txcAmount = sizeMB × rate × monthsPrepaid`. Rate stored as a config row, easy to tune.
- Cron-style server route `/api/public/lifecycle-tick` (called daily by external scheduler later): for each video, compute `viewsLast30d`. If below threshold AND credits exhausted → mark `expiring`, email-less notice on `/manage`. After grace period → unpin from Pinata, keep CID record.
- Reward accrual: each qualifying view adds to `creator_credits` (off-chain ledger v1; on-chain payout later).

**Embed code generator**
On `/v/$cid`, a textarea renders:
```html
<iframe src="https://video.texitcoin.org/embed/{cid}?autoplay=0&mute=0"
        width="640" height="360" allow="autoplay; fullscreen" frameborder="0"></iframe>
```
Toggles update the URL live.

**Database (Lovable Cloud)**
- `videos`: cid, owner_wallet, title, size_bytes, duration_s, status (transcoding/active/expiring/unpinned), tx_hash, created_at.
- `payments`: video_cid, wallet, txc_amount, tx_hash, months_prepaid.
- `view_events`: video_cid, ip_hash, ts (rolled up nightly into `video_stats`).
- `pins`: video_cid, pinata_id, expires_at.
- RLS: public read on `videos` + `video_stats`; writes only via server functions.

## Out of scope for this build (explicit)

- Real ffmpeg worker infrastructure (mock pipeline ships; real worker is a separate provisioning task).
- Real TXC chain calls (mocked behind a swappable interface).
- Email/push notifications (surface warnings on `/manage` only).
- DRM, age-gating, content moderation tooling.
- Reward payout transactions (we accrue credits; payout comes later).

## Risks & mitigations

- **Pinata gateway rate limits** under load → cache `.m3u8` and segments at the Worker edge for 60s; consider Cloudflare Stream as a future hot-content tier.
- **Abuse uploads (illegal content)** → CID-based blocklist table checked at gateway; takedown = unpin + add to blocklist.
- **Wallet UX on mobile** → use WalletConnect via wagmi connectors, not just injected.
- **MVP without real transcoder** = poor seek/streaming on large files → cap MVP uploads at 100MB until real worker is online.

## What ships at the end of this build

A working site where you can: connect a wallet, upload a small MP4, "pay" mock TXC, watch it play through our HLS gateway, see a view counter increment, copy an embed iframe that works on a third-party site, and see the video listed in `/manage` with a (mocked) on-chain timestamp link. Every real-world swap-in (ffmpeg worker, TXC RPC) is behind a single interface.
