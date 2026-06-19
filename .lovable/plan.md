## Phase 1 — route every gateway URL through `IPFS_GATEWAY_DOMAIN`

Fixes the three hardcoded leaks identified in the audit. No backend / Lambda changes; no schema changes.

### Changes

**1. `src/routes/v.$cid.tsx`** — replace two hardcoded `https://ipfs.honest.money/ipfs/{cid}` URLs:
- Thumbnail `<img src>` → use `ipfsThumbUrl(v.thumbnail_cid)` from `@/lib/ipfs-gateway` (already imported in similar components).
- Transcript download link `<a href>` → `/api/stream/${video.transcript_cid}`.

Both now resolve through `/api/stream/:cid`, which 302-redirects to whatever `gatewayUrl()` returns — i.e. `IPFS_GATEWAY_DOMAIN`.

**2. `src/components/OnChainProofPanel.tsx`** — replace `VITE_PINATA_GATEWAY_DOMAIN`:
- Remove the `pinataGateway` const (lines ~30–31).
- Change the metadata JSON link `href` from `https://${pinataGateway}/ipfs/${metadataCid}` to `/api/stream/${metadataCid}`.

### How to verify

After the edit:
- Visit a published video page and inspect the thumbnail `<img>` src — should be `/api/stream/{cid}`, not `ipfs.honest.money/...`.
- Click the transcript link (on a video that has one) — network tab shows the 302 redirect to `https://${IPFS_GATEWAY_DOMAIN}/ipfs/{cid}`.
- Open the On-Chain Proof panel, click "view metadata" — same 302 behavior.
- `grep -r "ipfs.honest.money\|VITE_PINATA_GATEWAY_DOMAIN" src/` returns nothing in app code (deploy scripts/docs under `docs/ipfs-aws/` keep their references — those configure the secret itself).

### Not touched in this phase
- Pinning destinations (still mixed — Pinata for thumbnails/JSON/comments, self-node for HLS). That's phase 2.
- `gatewayUrl()` fallback chain (`IPFS_GATEWAY_DOMAIN` → `PINATA_GATEWAY_DOMAIN` → public Pinata) stays as-is — useful safety net while old Pinata-only CIDs are still around.
- Footer copy ("pinned via pinata") — wait until phase 2 since it'd be inaccurate to change before pinning is actually self-node only.