## Live Archive with Consent

After a stream ends, the admin (you) sees "Archive to library?" / "Skip". Choosing Archive kicks off: MediaConvert stitches the raw .ts segments into HLS → pin the master to IPFS → create a normal (hidden) `videos` row you can then title/publish from `/manage`.

### Flow

```text
Stop stream ─▶ status=ended  ─▶  [Archive?]  [Skip]
                                    │           │
                                    ▼           ▼
                         MediaConvert stitch  status=skipped
                         .ts segments → HLS
                                    │
                                    ▼
                              cron reconciler
                                    │
                                    ▼
                       pin master.m3u8 → IPFS
                                    │
                                    ▼
                   create videos row (hidden), cid=<pinned>,
                   status='ready', owner_wallet=your wallet
                                    │
                                    ▼
                Manage list: rename / thumb / publish
```

### Changes

**Migration** — add to `live_streams`:
- `archive_status` text (`transcoding` | `pinning` | `ready` | `failed` | `skipped`)
- `archive_output_prefix` text (S3 URI of the MediaConvert output)

**Server**
- `src/lib/aws-mediaconvert.server.ts` — new `startHlsTranscodeFromInputs(inputUris[], outputPrefix, videoId)` (multi-input stitching).
- `src/lib/livestream.functions.ts`
  - remove auto-archive on stop (stop = status `ended` only, no side-effects).
  - `archiveLiveStream({id, wallet})` — lists archive .ts segments from `s3://txc-live-archive-.../txc-live/`, calls MediaConvert stitch, records `archive_transcode_job_id` + `archive_status='transcoding'`.
  - `skipLiveArchive({id, wallet})` — sets `archive_status='skipped'`.
- `src/routes/api/public/hooks/finalize-live-archive.ts` — cron reconciler: for each stream where `archive_status='transcoding'`, describe MC job; on COMPLETE, HEAD the output `master.m3u8` for size, pin via Lambda → get CID, insert a hidden `videos` row (owner=your wallet, title=stream title, source=`'live-archive'`) and mark `archive_status='ready'`.
- pg_cron entry running the new endpoint every 5 min.

**Client**
- `src/routes/manage.tsx` `GoLiveAdminSection` — for streams whose `status='ended'`, show `[Archive to library]` / `[Skip]` buttons when `archive_status` is null. Show status pill (`transcoding…` / `pinning…` / `ready → /v/<cid>` / `skipped`) once set.

### Notes

- `videos.source` doesn't currently include `'live-archive'`. I'll relax the check constraint (if any) in the migration, or use `'upload'` as the source and set a `metadata` flag — I'll pick during implementation depending on what's enforced.
- Videos start **hidden** so a bad stream doesn't auto-publish; you flip visibility from `/manage`.
- The reconciler is idempotent — safe to re-run.

I'll ship the migration first so you can approve, then wire the server + UI on the next turn.