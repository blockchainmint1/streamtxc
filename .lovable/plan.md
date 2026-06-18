## What you get

A new tab in the upload flow next to "Upload" / "URL Import": paste a Zoom share URL (and optional passcode), hit Import, and the backend pulls down the mp4 + transcript, runs your existing transcode → HLS → IPFS pin pipeline, and stamps everything on-chain.

## How it works

### 1. New UI: "Zoom" tab in `/upload-aws`

- Inputs: share URL, optional passcode, optional title override.
- On submit: calls a new server fn `startZoomImport({ url, passcode })`.
- Server fn returns `{ cid_placeholder, video_id }`. Page then polls existing video status the same way it does for normal uploads.

### 2. New server fn: `src/lib/zoom-import.functions.ts`

Steps inside `.handler()`:

1. **Resolve passcode (if any)** — POST to `https://zoom.us/rec/share/<token>` with `{ passwd: <code> }` form body to get a `_zm_ssid` cookie. Skip if no passcode.
2. **Fetch share page HTML** with that cookie + a real `User-Agent`.
3. **Extract recording metadata**:
   - Title — regex on `<meta property="og:title">` or page `<title>`.
   - Signed mp4 URL — regex on `https://ssrweb.zoom.us/cmr/replay/...\.mp4?...Signature=...` (confirmed present in the SSR HTML).
   - Transcript URL — Zoom inlines a JSON blob `__data__` / `window.__INITIAL_STATE__` with the share's `clipId`. We hit `https://zoom.us/nws/recording/1.0/play/share-info?canPlayFromShare=true&from=share_recording_detail&continueMode=true&componentName=rec-play&originRequestUrl=<encoded share url>` which returns JSON listing all 4 download files including `transcript_vtt_url`. If that endpoint shape changes, we fall back to the audio-only mp3 from MediaConvert + Lovable AI transcription (see step 6).
4. **Stream mp4 → S3 input bucket** using the existing multipart helper in `src/lib/backfill-hls.server.ts` (16MB chunks, up to 4GB). Key: `zoom/<random>/source.mp4`.
5. **Kick off HLS transcode** via `startHlsTranscode` (existing). Insert/update the `videos` row with `transcode_status='processing'`, source=`'zoom'`, title from page.
6. **Transcript**:
   - Preferred path: download the .vtt directly from Zoom (uses same cookies), store the raw text on the `videos` row in a new `transcript` text column, pin it to IPFS as `transcript.vtt`, and store `transcript_cid`.
   - Fallback path (no inline transcript): add an audio-only output to the MediaConvert job (mp3, mono, 64kbps), and after the job completes, send the audio to Lovable AI Gateway (`google/gemini-2.5-flash` with audio input — already free in the gateway) for transcription. Save same way.
7. **Stamp on-chain**: reuse existing `finalize-hls-pin` flow which already writes `hls_cid` + metadata; add `transcript_cid` to the on-chain metadata JSON so the proof includes it.

### 3. DB migration

- Add `transcript_cid text`, `transcript_text text`, `source text default 'upload'` to `public.videos`.
- Backfill source='upload' for existing rows.
- No new RLS — uses existing video RLS.

### 4. UI surface for transcript

- On `/v/$cid`, if `transcript_text` or `transcript_cid` is present, add a collapsible "Transcript" panel below the player. Plain text view + "Open .vtt on IPFS" link.

## Known limits (calling these out upfront)

- **Passcode-protected shares**: handled if user provides the passcode. If Zoom has added a captcha (rare on share links), the import will fail with a clear "Zoom requires a captcha — download manually and use the regular upload tab" error.
- **Login-required ("only signed-in users in your account can view") shares**: not supported. Cloudflare Workers can't run a headless browser, and Zoom's SSO flow needs one. Error message will say so.
- **Very large recordings (>4GB)**: rejected at the multipart step with a clear error. Zoom recordings are almost always well under this.
- **Transcript availability**: only works if Zoom generated one (host had "Audio transcript" enabled in cloud recording settings). If absent, fallback Whisper-style transcription on the extracted audio runs automatically; quality varies.

## Technical details

- All Zoom HTTP calls happen in the server fn; nothing leaks to the client.
- Signed mp4 URLs from Zoom expire (~7 days), so we stream into S3 immediately rather than storing the URL.
- The `zoom-import.functions.ts` file pattern matches existing imports (`imports.functions.ts`, `imports.server.ts`).
- No new secrets. No new connectors.
- Files changed/created:
  - `src/lib/zoom-import.functions.ts` (new)
  - `src/lib/zoom-import.server.ts` (new — html parsing + cookie helpers)
  - `src/components/ZoomImportTab.tsx` (new)
  - `src/routes/upload-aws.tsx` (add tab)
  - `src/components/VideoPlayer.tsx` or new `TranscriptPanel.tsx` + `src/routes/v.$cid.tsx` (transcript display)
  - `src/lib/finalize-hls-pin.server.ts` (include `transcript_cid` in stamp)
  - `src/lib/aws-mediaconvert.server.ts` (optional audio-only output for fallback)
  - one new Supabase migration

Want me to ship it?
