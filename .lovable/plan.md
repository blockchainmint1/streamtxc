# Livestream v1 — StreamYard → MediaLive → /live

You'll stream from **StreamYard** using its "Custom RTMP" destination
alongside YT/X/FB. That destination points at an AWS **MediaLive** input we
stand up on-demand; MediaLive re-encodes to a 3-rung ABR HLS ladder and
pushes it to **MediaPackage**, which our `<VideoPlayerV2>` plays on `/live`.

## Architecture

```text
  StreamYard (RTMP push)
        │
        ▼
  MediaLive input (RTMP_PUSH, 2 URLs for redundancy)
        │
        ▼
  MediaLive channel (STANDARD, HD, HEVC/H264 3-rung ladder)
        │
        ├── HLS output → MediaPackage channel
        │        │
        │        ▼
        │   MediaPackage HLS endpoint  ←  <VideoPlayerV2> on /live
        │
        └── Archive output → s3://txc-live-archive/<streamId>/
                       │
                       ▼  (on channel stop)
                 MediaConvert → HLS → S3 output bucket → IPFS pin
                       │
                       ▼
                 normal videos row (owner = admin wallet)
```

On-demand only: the channel is `IDLE` by default (~$0/hr). Admin clicks
**Go Live** in `/manage` → we start the channel via AWS API → StreamYard
can push RTMP → `/live` shows the stream. Admin clicks **End** → we stop
the channel and enqueue the archive → normal video row appears in the grid.

## Cost sanity check (us-east-1, on-demand)

| Item | Rate | Notes |
|---|---|---|
| MediaLive STANDARD HD channel | ~$1.15/hr running | $0 when stopped |
| MediaPackage HLS origin | $0.04/GB out | pennies for small audience |
| MediaLive → MediaPackage | free (same account) | |
| S3 archive storage | $0.023/GB/mo | delete after archive pin succeeds |
| Data transfer out | included in MediaPackage GB | |

A 2-hour stream with 50 concurrent viewers ≈ **$3-5 total**.

## Provisioning (one-time, CloudShell)

I'll ship `docs/ipfs-aws/terraform/04-medialive.yaml` — a CloudFormation
stack you deploy once in CloudShell. It creates:

- `AWS::MediaLive::InputSecurityGroup` (locked to your admin IP; you can
  widen later)
- `AWS::MediaLive::Input` (RTMP_PUSH, 2 destinations for StreamYard's
  primary + backup)
- `AWS::MediaPackage::Channel` + one HLS `OriginEndpoint`
- `AWS::MediaLive::Channel` (starts in IDLE state; ABR 720p/480p/360p)
- `AWS::S3::Bucket` for archives (with lifecycle rule)
- `AWS::IAM::Role` for the channel to write to MediaPackage + S3

**Outputs of the stack** (which you paste into Lovable secrets):
- `MEDIALIVE_CHANNEL_ID`
- `MEDIALIVE_INPUT_ID`
- `RTMP_PRIMARY_URL` + `RTMP_BACKUP_URL` + `RTMP_STREAM_KEY` (into StreamYard)
- `HLS_PLAYBACK_URL` (into `/live`)
- `LIVE_ARCHIVE_BUCKET` (into MediaConvert intake)

## App-side build

### Data

New table `live_streams`:

| col | type | notes |
|---|---|---|
| id | uuid pk | |
| title | text | |
| description | text | |
| status | enum(`scheduled`,`starting`,`live`,`ending`,`ended`,`archived`) | |
| scheduled_for | timestamptz null | powers the "next live" card |
| started_at | timestamptz null | |
| ended_at | timestamptz null | |
| hls_url | text | MediaPackage endpoint (same for all streams) |
| thumbnail_cid | text null | admin-uploaded pre-live cover |
| archive_video_cid | text null | populated after archive → videos row |
| owner_wallet | text | admin only for v1 |
| simulcast_youtube | text null | share links displayed on /live |
| simulcast_twitter | text null | |
| simulcast_facebook | text null | |

Realtime enabled so `/live`, homepage banner, and `/manage` update the
moment status flips.

### Server functions (`src/lib/live-streams.functions.ts`)

- `getCurrentLive()` — public, returns the live or next-scheduled row.
- `listLiveStreams()` — public, paginated (past archives).
- `createLiveStream({title, scheduled_for, ...})` — admin-only.
- `startLive({id})` — admin: MediaLive `StartChannel` + set status=`starting`.
- `stopLive({id})` — admin: MediaLive `StopChannel` + set status=`ending`,
  enqueue archive.
- `updateLiveStream(...)` — admin edit metadata.

MediaLive control uses `aws4fetch` (same pattern as `aws-mediaconvert.server.ts`)
against `medialive.us-east-1.amazonaws.com`.

### Routes / UI

- **`src/routes/live.tsx`** — public. Shows HLS player when
  `status === 'live'`, else offline card with next scheduled time +
  countdown + simulcast links + last archive.
- **`src/routes/manage.tsx`** — new admin panel: create stream, show RTMP
  URL + key (copy button), Go Live / End Live buttons, live viewer count
  (from `view_events`), simulcast link inputs.
- **`src/routes/index.tsx`** — red `LIVE` badge + banner strip when a
  stream is active.
- **`src/components/Header.tsx`** — `LIVE` pulsing dot next to the logo
  when active.

### Chat during stream

Reuse `Comments.tsx` in "live mode": scoped to the `live_streams.id`
instead of a video CID, realtime subscribed, no boosts (or paid boosts —
TBD later). Cheapest v1 = wire Comments to accept a `liveStreamId` alt-key.

### Notifications on go-live

On `startLive()`, enqueue a notification fan-out (reuse
`notifications.server.ts`):
- Email subscribers with a "we're live" template + `/live` link.
- Telegram bot broadcasts.

### Auto-archive → normal video row

MediaLive writes segments to `s3://<archive-bucket>/<streamId>/`. On
`stopLive()`:
1. Wait ~30s for MediaLive to flush its final segments.
2. Kick off `startHlsTranscode()` with the archive prefix as input (single
   concatenated MP4; MediaLive Archive output writes MP4 chunks — we
   concat via MediaConvert input clipping).
3. The existing MediaConvert webhook already does S3 → HLS → IPFS pin →
   `videos` row. We add a marker (`source_kind = 'live_archive'`,
   `live_stream_id = <id>`) so the archive links back to the stream.
4. Once archived, delete the raw MediaLive segments from the archive
   bucket (lifecycle rule as backup).

### Homepage banner + Header dot

Both read the same lightweight `getCurrentLive()` server fn via
`useQuery({ staleTime: 30_000 })`. Realtime subscription flips status
instantly for logged-in browsers; polling covers the rest.

## Rollout order

1. **This turn:** plan + CloudFormation template + `live_streams` migration.
2. **Next turn (after migration approved):** server functions +
   admin panel on `/manage` + `/live` route with player + LIVE badge.
3. **Turn after:** chat wiring + notification fan-out + auto-archive.

---

# Prior work — thumbnail gateway fallback (kept for reference)

# Why the new thumb won't show

I traced the layers and found the actual culprit. It's not the DB and not React Query caching — it's the **self-hosted IPFS gateway**.

## Evidence

| Layer | Result | What it means |
|---|---|---|
| `videos.thumbnail_cid` in DB | `bafkreiexqk4jznorga33odddvpalap67tvxlkok7ndlswfqvnhre2claxi` | Edit saved correctly ✅ |
| Pinata gateway for that CID | `200 OK`, 148 KB image/jpeg | Bytes exist on Pinata ✅ |
| `ipfs.io` gateway for that CID | `200 OK`, 148 KB image/jpeg | Bytes exist on the public network ✅ |
| `ipfs.honest.money` (self-node) for that CID | **Hangs 15s → timeout (HTTP 000)** | Self-node does NOT have it ❌ |
| `ipfs.honest.money` for the original video CID `QmZj…` | `200 OK` in 288 ms | Self-node is healthy, just missing this blob |

Since the Phase 2 change made `gatewayUrl()` prefer the self-node, the watch-page poster URL (`/api/stream/<thumb>`) 302-redirects to `https://ipfs.honest.money/ipfs/bafkreiexqk…`, which hangs. The `<img>` request silently fails after a long timeout, so the player slot stays black (or shows whatever the browser cached from before).

## Root cause options (need to confirm which)

The new thumb was pinned through `pinFileToIPFS → addToSelfNode → POST /add` on the Lambda. It returned a CID (the one now in the DB), so the call appeared to succeed. But the gateway can't serve it. That points to one of:

1. **The Phase 2 Lambda redeploy never landed.** The new `/add` route doesn't exist on the live Lambda yet, and a different path (maybe an SDK fallback) handed back a computed CID without actually adding bytes to kubo.
2. **`/add` is deployed but isn't pinning.** Less likely — the code passes `pin=true` and `raw-leaves=true`, which should add + pin in one shot. But worth verifying with `/api/v0/pin/ls` on the node.
3. **Pin succeeded, kubo is still resolving across the network.** Unlikely for a 148 KB blob that's been on Pinata for hours — kubo should have it locally if `/add` actually ran.

Most likely: **(1)**. The CloudShell redeploy instructions from earlier need to be run.

## Plan

### 1. Verify Lambda state — copy/paste diagnostic (no code changes)

You'll run this in CloudShell. If `/add` returns a CID for a tiny test file but the gateway still can't serve it, we know the bug is in `/add`. If `/add` returns a 4xx/5xx, we know the Lambda wasn't redeployed.

```bash
. ~/txc-ipfs/deploy-output.env
echo "hello-$(date +%s)" > /tmp/probe.txt
echo "=== POST /add ==="
curl -sS -X POST "$IPFS_LAMBDA_URL/add" \
  -H "Authorization: Bearer $IPFS_LAMBDA_TOKEN" \
  -F "file=@/tmp/probe.txt"
echo
echo "=== Is the broken thumb pinned on the node? ==="
curl -sS "$IPFS_LAMBDA_URL/pin-cid" \
  -H "Authorization: Bearer $IPFS_LAMBDA_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"cid":"bafkreiexqk4jznorga33odddvpalap67tvxlkok7ndlswfqvnhre2claxi"}'
```

- `/add` returns a `bafy…` CID → route is live; the missing-pin issue is real and `/pin-cid` will pull it from the network and pin it (fixes the immediate bad row).
- `/add` returns 404 / "route not found" → redeploy the Lambda using the Phase 2 script, then re-run.

### 2. App-side defensive fix — fall through to Pinata when self-node misses

Right now `/api/stream/$cid` blindly 302s to `gatewayUrl(cid)`, which is the self-node. If the self-node doesn't have the CID, the user sees a hang or a black box. Change it to:

- Issue a short HEAD probe to the self-node (~2 s timeout).
- On 200 → 302 to self-node (current behavior).
- On miss / timeout → 302 to Pinata gateway instead.
- No caching of the decision (we still want `no-store` on the 302).

This keeps the self-node primary for cost/independence but means a missing pin never breaks the UI — Pinata always serves while we backfill the self-node.

Files touched:
- `src/routes/api/stream.$cid.tsx` — add the HEAD-probe fallthrough.
- `src/routes/api/stream.$cid.$.tsx` — same logic for HLS subpaths (use `headCidOnGateway` against the directory CID).
- `src/lib/pinata.server.ts` — small helper `pinataGatewayUrl(cid)` that ignores `IPFS_GATEWAY_DOMAIN` and returns the Pinata URL specifically, so the fallback target is explicit.

### 3. Backfill helper — re-pin everything the self-node is missing

We already have `pinCidOnNode` in the Lambda and a `backfill-self-pins` admin route. Extend that route (or add a new one) to:

- Walk recent `videos` rows.
- For each `thumbnail_cid`, `metadata_cid`, `hls_cid`, and `cid` — HEAD-probe `ipfs.honest.money`.
- Anything that misses → call Lambda `/pin-cid` to pull from the network.

That brings any rows in the same state (saved-in-DB-but-not-on-self-node) back in sync without a manual sweep.

### 4. Document the convention in `mem://`

Save a `constraint` memory: "Self-node IPFS gateway is primary; `/api/stream/*` must HEAD-probe and fall through to Pinata. Don't remove the fallback — a missing self-node pin will silently break thumbnails/players." So this doesn't get refactored away later.

## What you'll see when it's done

- New thumb on `/v/QmZj…` shows immediately (Pinata serves it while the self-node is still missing).
- Network tab: `/api/stream/<bafkrei…>` → 302 → `gateway.pinata.cloud/ipfs/<bafkrei…>` → 200 jpeg.
- After running step 1's `/pin-cid` command, the 302 starts going to `ipfs.honest.money` instead (cheaper path).
- Step 3 backfill makes sure no other rows are stuck in this half-state.

## Out of scope for this turn

- Changing how `editVideoMetadata` pins (it already calls `pinFileToIPFS`; the call returns a CID so the client-side path is fine).
- Reworking the Phase 2 deploy script (we'll only re-run it if step 1 shows `/add` isn't live).
