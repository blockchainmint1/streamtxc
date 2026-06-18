## The bug

The chosen thumbnail keeps getting lost between picking it and the final `register()`/`addCid()` call. The current upload page builds the whole videos row in one shot at submit time — title, thumbnail CID, NSFW flag, size, etc. — so anything that interrupts that final call (tab switch, double-click, a re-render reset, the file getting replaced, transcode kickoff) drops the in-memory thumbnail CID.

## The fix (architecture change)

Move from "build the row at submit" to "draft-first": create the videos row the moment the upload page opens, and patch it as each piece of data becomes available. The file/CID-finalization step just flips the draft to active.

### Lifecycle

```text
page opens          → POST createDraft()           → row id=<uuid>, status='draft', cid=null
user types title    → patchDraft({ title })
user picks thumb    → patchDraft({ thumbnailCid })  (pin already happened)
user toggles NSFW   → patchDraft({ nsfw })
upload completes    → finalizeDraft({ cid, size, mime })  → status='active', cid set, stamp on chain
```

If the user closes the tab mid-flow, the draft sits unused and gets garbage-collected by a daily cron after 24h.

### Schema

`videos` today is keyed on `cid` (NOT NULL). Drafts need an id before a CID exists. Two options — I'll go with **A** because it's the smallest change:

- **A.** Add `id uuid primary key default gen_random_uuid()`, make `cid` nullable, add `status='draft'` as an allowed value, and a partial unique index `(cid) where cid is not null`. Existing rows backfill `id` automatically.
- B. Keep `cid` PK and seed drafts with a synthetic `draft-<uuid>` value. Cheaper migration but pollutes every `cid` query — rejected.

New columns / changes:
- `id uuid pk default gen_random_uuid()`
- `cid text` → nullable
- `status` allowed: `draft | active | …existing values…`
- partial unique index on `cid`
- `draft_owner_token text` — random token issued at create, required to patch/finalize (so anonymous drafts are scoped to the browser that created them)
- cron: delete drafts older than 24h with `cid is null`

### Server functions (new, in `src/lib/videos.functions.ts`)

- `createUploadDraft()` → `{ id, token }`. No auth required; anonymous uploads still work.
- `patchUploadDraft({ id, token, title?, description?, thumbnailCid?, nsfw? })` → updates whatever fields are present, ignores undefined.
- `finalizeUploadDraft({ id, token, cid, sizeBytes, mimeType, months, wallet? })` → fills in the cid, flips status to `active`, then runs the existing TXC stamp / `addByCid` logic. Reuses `thumbnail_cid` from the row — does NOT accept it as a parameter.

The existing `registerUpload` / `addByCid` stay for callers I don't touch this turn (the embed flow, Zoom import server side). New upload pages call the draft trio instead.

### Client wiring

`src/routes/upload-aws.tsx` and `src/routes/upload.tsx`:
- On mount: call `createUploadDraft`, store `{ id, token }` in component state.
- Title/description `onBlur` → debounced `patchUploadDraft`.
- `ThumbnailPicker` `onChange(cid)` → immediately `patchUploadDraft({ thumbnailCid: cid })`. The pinning ref / 30s wait-loop goes away entirely.
- NSFW toggle → `patchUploadDraft({ nsfw })`.
- Submit handler keeps doing the IPFS lookup + Pinata upload + S3 PUT, then calls `finalizeUploadDraft({ id, token, cid, sizeBytes, mimeType, months, wallet })`. No more passing `thumbnailCid` from React state through the submit path.

For the CID-import path inside upload-aws (the second form on the same page), I'll create a second draft when the CID tab becomes active.

### Why this fixes the symptom

Today's failure mode: `thumbnailCidRef.current` is read at finalize time. Anything that resets the picker (re-render of the parent that swaps the `file` prop reference, re-mounting on tab switch, the `useEffect([file, videoSrc])` cleanup firing) wipes the local state before submit reads it. Draft-first writes the thumbnail to the database the instant it's pinned, so the finalize call doesn't depend on React state at all — the row already has it.

## Out of scope (call out, don't build this turn)

- Zoom / Dropbox / URL import tabs — they currently go through `imports.server.ts` and pin asynchronously; they should also use drafts, but that's a separate pass.
- Restore (`v.$cid.restore.tsx`) — unrelated to upload.
- A "Resume draft" UI — drafts just expire silently for now.

## Files touched

- new migration: id/cid nullability, draft status, partial unique, cleanup cron
- `src/lib/videos.functions.ts` — add the three draft fns
- `src/routes/upload-aws.tsx` — switch to draft flow
- `src/routes/upload.tsx` — switch to draft flow
- `src/components/ThumbnailPicker.tsx` — drop `onPinningChange` (no longer needed)
