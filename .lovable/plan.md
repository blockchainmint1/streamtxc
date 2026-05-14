## What we're building

A third tab on `/upload` next to "Upload file" and "Add by CID":

```text
┌─────────────────────────────────────────────────┐
│  Upload file   Add by CID   ▶ Import from URL   │
├─────────────────────────────────────────────────┤
│  Paste a WeTransfer or Dropbox link             │
│  [_____________________________________] [Resolve] │
│                                                 │
│  ✓ wetransfer.com — "ron-paul-bbq.mp4" (2.4 GB)│
│  Title  [Bobby Gray @ Ron Paul's 90th BBQ____] │
│  Quote  10.00 TXC ($1.20) — 1 month            │
│                                                 │
│  [▶ Pin to IPFS]                                │
│  ─────────  Streaming 1.2 GB / 2.4 GB (50%) ── │
└─────────────────────────────────────────────────┘
```

Imported videos go through the **same** register + pay-to-host flow as regular uploads — the importer just replaces the "user picks a file from disk" step with "server fetches it from a third-party URL and pins it for you."

## Sources we'll support in v1

| Source        | How we get the direct link                                                                 |
|---------------|--------------------------------------------------------------------------------------------|
| WeTransfer    | Scrape the share page for `csrf-token` + cookie, POST to their `/api/v4/transfers/.../download` endpoint, get `direct_link`. |
| Dropbox       | Trivial URL rewrite: `?dl=0` → `?dl=1`, or `dropbox.com/s/...` → `dl.dropboxusercontent.com/s/...`. HEAD for size. |

Adding more later (Google Drive, Vimeo, plain `https://...mp4`) is a one-file change to the resolver registry.

**Multi-file WeTransfer caveat**: if the link bundles >1 file, WT only gives us a ZIP. Pinning a ZIP as a "video" won't play. v1 detects this and shows: *"This WeTransfer link contains multiple files. Send a single-file transfer."*

## Architecture

User picked **stream through our server, normal payment flow, 1–5 GB typical**, so:

1. Browser POSTs the URL to `resolveImportUrl` → server figures out the source, returns `{filename, sizeBytes, source, importToken}`. The token is an HMAC-signed envelope `{directUrl, filename, size, exp(15min)}` — keeps the import endpoint from being a generic "fetch any URL into our Pinata account" attack surface.
2. UI shows file metadata + the existing Title / Description / Thumbnail / Quote panel.
3. Click "Pin to IPFS" → POST the token to `/api/public/import-stream`.
4. The Worker:
   - Verifies the token, inserts a row into a new `imports` table (`status='streaming'`, `bytes_total`).
   - Opens `fetch(directUrl)` and wraps the response body in a `TransformStream` that bumps `bytes_uploaded` on the row every ~256 KB.
   - Hand-builds a multipart body with that wrapped stream as the `file` part and POSTs it to `https://uploads.pinata.cloud/v3/files` with the known `Content-Length`.
   - On success: writes `cid`, flips status to `done`.
5. UI polls `getImportStatus(id)` every 1s for the progress bar; once `status === 'done'`, calls the existing `registerUpload` server fn with the new CID and the user's title / wallet / months — same path as a normal upload from there on (payment quote, deposit address, the works).

```text
Browser            Worker SSR                 WeTransfer / Dropbox        Pinata v3
   │ resolveUrl ──▶ │
   │                │ scrape page + API call ──▶ │
   │                │ ◀── direct link + size + filename
   │ ◀── token ─────│
   │                                                                          
   │ POST /import-stream ─▶ │
   │                        │ insert imports row (streaming, 0/2.4GB)
   │                        │ fetch(directUrl) ──▶ │
   │                        │ ◀── ReadableStream ──│
   │                        │ ── piped through TransformStream (counts bytes)
   │                        │ ── multipart upload ──────────────────────────▶ │
   │                        │ ◀── { cid, size } ───────────────────────────── │
   │                        │ update row → status=done, cid=…
   │ ◀── { id } ────────────│
   │                                                                          
   │ poll getImportStatus(id) every 1s → progress bar                         
   │                                                                          
   │ once done: registerUpload({ cid, ... })   (existing flow)                
```

## Files to add / change

### New
- `src/lib/import-sources.server.ts` — resolver registry. `resolveWeTransfer(url)`, `resolveDropbox(url)`. Each returns `{ directUrl, filename, sizeBytes, source }` or throws.
- `src/lib/imports.server.ts` — multipart streaming helper, HMAC token sign/verify, DB row updates with throttled progress writes.
- `src/lib/imports.functions.ts` — `resolveImportUrl`, `getImportStatus` server fns.
- `src/routes/api/public/import-stream.ts` — POST handler that does the streaming pin (separate from the server fn so we can pipe streams without serializing through the RPC layer).
- `src/components/UrlImportTab.tsx` — the new tab UI: URL input → metadata preview → progress bar.

### Edited
- `src/routes/upload.tsx` — add the third tab; on import success, reuse the existing register-with-CID code path.
- `src/lib/pinata.server.ts` — add `pinStreamToIPFS(stream, filename, size)` that builds the multipart body manually so we don't have to load the whole file into memory.

### Database (migration)
```sql
create table public.imports (
  id uuid primary key default gen_random_uuid(),
  source text not null,                -- 'wetransfer' | 'dropbox'
  source_url text not null,
  filename text not null,
  bytes_total bigint,
  bytes_uploaded bigint not null default 0,
  status text not null check (status in ('pending','streaming','done','failed')),
  cid text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.imports enable row level security;
-- service-role-only; UI reads through server fns.
```

### Secret
- `IMPORT_TOKEN_SECRET` — random 32-byte string used to HMAC-sign the import token so users can't replace `directUrl` with an arbitrary URL.

## Security & abuse considerations

- The import-stream endpoint **requires a fresh signed token** from `resolveImportUrl` (15 min expiry). No token = no streaming. Without this, anyone could point our Pinata account at huge arbitrary URLs and rack up the bill.
- `resolveImportUrl` only accepts host allowlist: `wetransfer.com`, `we.tl`, `dropbox.com`, `dl.dropboxusercontent.com`. Reject everything else with a clear error.
- Hard cap: refuse imports above 10 GB (configurable). Cloudflare's streaming can handle bigger but the practical risk is real.
- Same payment gate as regular uploads — wallet still owes the TXC quote. No free hosting.

## Risks I'm flagging up front

1. **WeTransfer breaks their internal API regularly.** This is the most fragile piece. When WT changes their CSRF / endpoint shape, the resolver stops working until we update it. We'll log resolver errors clearly so you know when to ping me.
2. **Cloudflare Worker wall-clock.** On the free Workers plan, requests are capped at ~30s — a 2 GB stream definitely won't fit. On Workers Paid + Unbound (which `cloudflare.com/workers/pricing` and most production Lovable Cloud projects use) it's effectively unlimited for streaming; this is what makes 1-5 GB realistic. If you're on the free tier this won't work and we'd need to switch to background-job architecture instead.
3. **No resume.** If the connection drops mid-stream (you close the tab, Pinata blips, WT 504s) the import fails and you start over. Adding TUS resumable on the Pinata side is a v2.
4. **Cold-cache HEAD on Dropbox.** Some Dropbox shares 302-redirect through their auth flow before HEAD returns the real `Content-Length`. We'll do a follow-redirect HEAD; if size is unknown we still pin, just without a progress bar (spinner instead).

## Out of scope (v1)

- Google Drive, Vimeo, YouTube, generic `https://...mp4` (easy to add later — same resolver pattern).
- Multi-file WeTransfer transfers (we'll detect + reject).
- TUS resumable uploads / pause-and-resume.
- Browser push notifications when a long import finishes.
