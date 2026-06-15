## Adaptive Video Streaming with AWS MediaConvert + IPFS (Pinata)

Goal: replace single-file IPFS playback with HLS adaptive bitrate streaming. Originals stay pinned; three transcoded renditions (720p, 480p, 360p) plus an HLS master playlist get pinned to Pinata and recorded on-chain alongside the original CID.

---

### Architecture

```text
Browser ─► our /api/uploads (existing) ─► Supabase Storage (video-uploads)
                                              │
                                              ▼
                                  pin original → Pinata (CID_orig)
                                              │
                                              ▼
                              copy to S3 input bucket (transcode-input)
                                              │
                                              ▼
                              MediaConvert job (HLS, 3 renditions)
                                              │
                                              ▼
                                   S3 output bucket (transcode-output)
                                              │
                                              ▼
                       EventBridge → /api/public/hooks/mediaconvert
                                              │
                                              ▼
              pin entire HLS folder to Pinata as a directory  →  CID_hls
                                              │
                                              ▼
                update videos row: { cid, hls_cid, renditions[] }
                                              │
                                              ▼
                stamp updated JSON to chain (existing flow, new schema)
```

Playback: `VideoPlayer.tsx` checks `hls_cid` first → loads `https://{gateway}/ipfs/{hls_cid}/master.m3u8` via hls.js (ABR auto). Falls back to direct MP4 from `cid` for legacy videos or while a job is still processing.

---

### Phases

**Phase 1 — AWS wiring (infra + secrets)**
- New secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_INPUT_BUCKET`, `AWS_S3_OUTPUT_BUCKET`, `AWS_MEDIACONVERT_ROLE_ARN`, `AWS_MEDIACONVERT_ENDPOINT`, `MEDIACONVERT_WEBHOOK_SECRET`.
- User provisions in AWS: 2 S3 buckets, IAM role for MediaConvert, EventBridge rule → HTTPS destination pointed at `/api/public/hooks/mediaconvert` with HMAC signing.
- I'll write a one-page setup checklist with the exact IAM policy JSON and EventBridge target config.

**Phase 2 — Schema + migration**
Add to `videos`:
- `hls_cid text` — directory CID of the HLS bundle
- `renditions jsonb` — `[{ height, bitrate, cid, playlist }]`
- `transcode_status text` — `pending | processing | ready | failed`
- `transcode_job_id text`
- `transcode_error text`

Existing `cid` column keeps the original. Old rows render fine because `hls_cid` is null → player falls back.

**Phase 3 — Upload pipeline change**
In the existing upload server fn, after pinning the original:
1. Copy/upload the file to S3 input bucket.
2. Kick off a MediaConvert job (HLS output, 3 renditions: 1280×720@2.5Mbps, 854×480@1.2Mbps, 640×360@600kbps, 6s segments).
3. Set `transcode_status='processing'`, save `transcode_job_id`.
4. Return immediately — UI shows "Processing higher-quality streams…" badge.

**Phase 4 — Webhook + pinning**
`src/routes/api/public/hooks/mediaconvert.ts`:
- Verify HMAC signature.
- On `COMPLETE`: list output S3 objects, stream each to Pinata as a single directory pin (`pinFileToIPFS` with `wrapWithDirectory`), get back the directory CID.
- Update `videos`: `hls_cid`, `renditions[]`, `transcode_status='ready'`.
- Re-stamp the updated JSON payload to chain (reuse existing stamp flow).
- On `ERROR`: set status `failed` + error message.

**Phase 5 — Player**
Add `hls.js` dep. Update `VideoPlayer.tsx`:
- If `hls_cid` present and `hls.js` supported → attach HLS, let ABR handle quality switching.
- Native HLS (Safari) → set `<video src>` directly.
- Else / no `hls_cid` → existing MP4 path from `cid`.
- Add a tiny quality indicator (Auto / 720 / 480 / 360) wired to hls.js levels.

**Phase 6 — UI polish + backfill**
- Upload page: show transcode status pill on the user's recent uploads.
- Admin/creator action: "Re-transcode" button for legacy videos (re-runs Phase 3 against an existing original CID by fetching from gateway → S3 → MediaConvert).

---

### What I need from you before I start coding

The only blocker is the AWS credentials and bucket names from Phase 1. I'll write Phases 2–6 first (they don't need AWS to compile), wire the secrets last, and give you the AWS setup checklist in the same pass so you can provision while I build.

Sound good? If yes, I'll start with Phase 2 (migration) and Phase 5 (player upgrade) in parallel, then move into the upload + webhook pipeline.
