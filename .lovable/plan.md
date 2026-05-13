## Root cause (confirmed)

`src/lib/ipfs-cid.ts` `isCidOnIpfs()` does `fetch('/api/stream/<cid>', { method: 'HEAD' })` and trusts `res.ok`.

`/api/stream/:cid` (in `src/routes/api/stream.$cid.tsx`) **always** returns a `302` redirect to the gateway, without checking existence. On the production host that redirect lands on `https://streamtxc.com/api/stream/<cid>`, which returns **`200 text/html`** (the SPA shell). `fetch` follows the redirect, sees `200`, and reports the CID as "on IPFS" — for *every* CID.

Verified with `curl -IL` against the live `bafybeie2pykofxtopbc4pzz7nqohxrvld5spcgt3ltsar63zd6ves5b3dy`: final response is `HTTP/2 200, content-type: text/html`.

After the false positive, `handleSubmit` calls `addByCid`, which calls `pinByCid()` (no-op for an unknown CID) and then probes the Pinata gateway for up to 30 s for a `content-length`. That's the "not doing anything" — it's hung on the probe, eventually throwing `CID_NOT_FOUND`.

## Fix

Replace the unreliable redirect-follow probe with a true "is this in our Pinata account?" check. That's the only case where skipping the upload is actually safe.

### Changes

1. **New server fn `lookupPinnedCid`** in `src/lib/videos.functions.ts`
   - Input (Zod-validated): `{ cidV1: string, cidV0: string }` using existing `cidStringSchema`.
   - For each CID, in parallel, `GET https://api.pinata.cloud/v3/files/public?cid=<cid>` with `Authorization: Bearer ${process.env.PINATA_JWT}`.
   - Treat as a hit only when the response is `200` and `data.files` is a non-empty array.
   - Return `{ cid: string, version: 0 | 1 } | null`. Prefer v1 on tie.

2. **`src/routes/upload.tsx`** — swap the two callers of `findCidOnIpfs`:
   - In the file-selected `useEffect`: call `lookupPinnedCid({ data: { cidV1: cids.v1, cidV0: cids.v0 } })` via `useServerFn`.
   - In `handleSubmit`: same swap; keep the existing UX (toast, `addByCid`, navigate).
   - Drop the `findCidOnIpfs` import. `computeCids` stays.

3. **`src/lib/ipfs-cid.ts`** — delete `isCidOnIpfs` and `findCidOnIpfs` (only used by upload). Keep `computeCids` / `computeCidV0` / `computeCidV1`. Quick `rg` first to confirm no other callers; if any exist, leave the helpers but mark them with a comment saying they're unreliable for existence checks.

4. **No change to `/api/stream/:cid`** — its redirect behavior is correct for playback. The bug was using it as an existence probe.

5. **Optional nicety in `addByCid` (`src/lib/videos.functions.ts`)**: if a future caller still hits the 30 s probe, surface a clearer toast — but that's not needed once the upload flow stops sending phantom CIDs into it.

### Why not "probe the public IPFS DHT"

Even a correct gateway check (no SPA fallthrough) only tells us whether *some* peer on IPFS has the bytes — not whether Pinata has them, which is what we actually need for reliable playback. Pinning happens on Pinata; checking Pinata's own pinset is the correct signal. If a user genuinely wants to register a foreign CID, the **Add by CID** tab already exists for that.

### Technical details

- Pinata endpoint shape: `GET /v3/files/public?cid=<cid>` → `{ data: { files: [{ id, cid, ... }], ... } }`. Empty `files` ⇒ not in our account.
- `lookupPinnedCid` runs server-side so the JWT never reaches the browser.
- No DB migration, no schema change, no UI redesign — pure plumbing swap.

## Out of scope

- Adding a `HEAD` mode to `/api/stream/:cid` that returns `404` for unknown CIDs (would need to authenticate to Pinata first; not worth it just to keep the current probe alive).
- Re-enabling cross-account "found on public IPFS, skip upload" — see above; if you want it back, it should live behind the explicit Add-by-CID flow.
