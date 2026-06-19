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
