## Confirming your memory

You're right. The chat history (msgs #16–#18, #105, #251–#254) shows we deliberately switched to direct browser→Pinata TUS uploads to escape Cloudflare Worker's ~100 MB request-body cap, knowing the trade-off was Pinata's CORS allowlist. Every new custom domain (`stream.texitcoin.org`, `streamtxc.com`, `www.streamtxc.com`, plus Lovable preview hosts) re-triggers the allowlist problem.

Both diagnoses from earlier are true at the same time:
- **Immediate cause** of today's error: `streamtxc.com` is not in the Pinata API key's CORS allowlist.
- **Root cause** of why we're exposed to that allowlist at all: we route uploads direct-to-Pinata to dodge the Worker body cap.

The pragmatic fix: take Pinata CORS off the critical path. Cap uploads at 100 MB so they fit through our Worker, and route larger files through the existing **Add by CID** flow (which doesn't transfer bytes through us).

## Plan

### 1. Lower the cap to 100 MB
- `src/lib/fees.ts`: change `MAX_UPLOAD_BYTES` from `1024 * 1024 * 1024` to `100 * 1024 * 1024`.
- All server-fn validators (`getUploadUrl`, `registerUpload`, `finalizeUpload`) already reference this constant, so they update automatically.
- All UI copy that uses `formatBytes(MAX_UPLOAD_BYTES)` ("max 100.0 MB") updates automatically too.

### 2. Replace the direct-to-Pinata browser flow with a Worker-proxied multipart upload
- **New server route**: `src/routes/api/public/upload.ts`
  - `POST` handler reads `request.formData()`, pulls the `file` field (a `File`/`Blob`), enforces `≤ MAX_UPLOAD_BYTES`, calls existing `pinFileToIPFS(blob, filename)` from `src/lib/pinata.server.ts`, and returns `{ cid, size }` as JSON.
  - Same-origin call from the SPA, so no CORS headers needed; basic input validation (filename length, size cap) inline.
- **`src/routes/upload.tsx`**:
  - Drop `PinataSDK`, `browserPinata`, `uploadToPinata`, `sanitizeFilename`'s base64-presign concerns, and the `getUploadUrl` server-fn call.
  - New `uploadViaWorker(file, onProgress)` helper: builds a `FormData`, POSTs to `/api/public/upload` via `XMLHttpRequest` so we still get progress events (fetch can't stream upload progress in browsers yet). Returns `{ cid, size }`.
  - `handleSubmit` flow becomes: hashing → `lookupPinnedCid` → if hit, `addByCid`; else `uploadViaWorker` → `registerUpload`.
  - Keep `sanitizeFilename` (Pinata still rejects non-Latin1) — but we no longer have the presign/sanitize mismatch problem.
- **Deprecate but don't delete** `getUploadUrl` server fn — leave a comment that it's unused; can be removed in a later cleanup pass once we're sure we're not reverting.

### 3. UX for files >100 MB
- In `upload.tsx`, when the picked file's size exceeds `MAX_UPLOAD_BYTES`, show a clear inline panel (replacing the current bare red "TOO LARGE" pill):
  - Headline: "File is over 100 MB — direct upload not supported"
  - Body: "Pin the file to IPFS yourself first, then paste the CID below. We recommend [pinata.cloud](https://pinata.cloud) (free tier covers most uploads)."
  - CTA button: "Switch to Add by CID" — programmatically switches the `Tabs` to the `cid` tab and pre-fills `cidTitle` from the file name.
- Helper text under the file picker (always visible, not just on overflow): "Max 100 MB. Larger files? Pin to IPFS first (e.g. [pinata.cloud](https://pinata.cloud)) and use the **Add by CID** tab."

### 4. No DB / schema / payment changes
The server route just calls `pinFileToIPFS` and returns the CID. `registerUpload` stays exactly as is.

## Technical details

- Cloudflare Workers cap request bodies around 100 MB. A 100 MB file in multipart form-data is ~100 MB + a few hundred bytes of boundary overhead — within margin. If we ever hit edge-case rejections we can drop the cap to 95 MB; not worth pre-optimizing.
- `XMLHttpRequest` is the right choice for the upload because `fetch()` doesn't expose upload progress events in any current browser. We already use `XHR` style progress in the existing code path.
- `request.formData()` in the server route streams parsing — it doesn't double-buffer the body in Worker memory.
- The new server route lives under `/api/public/*` so it's reachable without auth (matches our other public endpoints). It's not a webhook, so no signature verification — but it's rate-limited implicitly by Pinata's own quotas and by the size cap. We can layer in a per-IP token-bucket later if abuse appears.

## Out of scope

- Re-adding direct-to-Pinata TUS as a "large files" path. If we want browser→Pinata back later, it should be gated on the user explicitly granting permission and we should add domains to Pinata's CORS allowlist proactively.
- Streaming/resumable uploads through our Worker (would need TUS-on-Workers or similar). For 100 MB files a single shot is fine.
- Touching the `addByCid` server fn — its 30 s gateway probe behavior is unchanged.
