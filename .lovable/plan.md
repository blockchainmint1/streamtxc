## Phase 2 — self-node primary, Pinata backup, for every flow

Goal: **every pin** writes to the self-hosted IPFS node first (must succeed). **Then** a best-effort `pinByHash` to Pinata as the backup. No flow stays Pinata-first.

This needs (a) one new Lambda route, (b) app-side rewrites of every pin helper, (c) you re-running the deploy script in CloudShell.

---

### Part A — Lambda change: add `POST /add`

Today the Lambda has `/pin` (streams S3 → kubo), `/pin-cid` (pins an existing CID), `/pin-by-hash` (proxy to Pinata), `/health`. There's no way to push raw bytes into kubo — which is why thumbnails / JSON / comments all reached for Pinata. We add one route:

`POST /add` — accepts `multipart/form-data` with one or more `file` parts, forwards to kubo `/api/v0/add?cid-version=1&raw-leaves=true&pin=true` (with `wrap-with-directory=true` when >1 part). Returns `{ cid, files, totalBytes, manifest }` — same shape as `/pin`.

I'll patch three files in lockstep so they stay identical:
- `docs/ipfs-aws/txc-ipfs-deploy-v3.sh` (canonical)
- `public/txc-ipfs-deploy-v3.sh` (served at https://streamtxc.com/txc-ipfs-deploy-v3.sh)
- `txc-ipfs-deploy-v3.sh` at repo root (currently stale — I'll resync it)

Inside the script: add the `/add` handler to the inline Lambda code, add `RouteAdd` to the CFN template, and add a small idempotent "ensure /add route exists" block next to the existing `/pin-cid` one (lines 705-713) so re-running the script on an already-deployed stack just adds the new route without recreating anything.

### Part B — App-side: flip every pin helper to "self-node first, Pinata backup"

**`src/lib/pinata.server.ts`** — rewrite each helper:

- `pinFileToIPFS(blob, filename)` → POST `/add` with single file (primary, throws on fail). Then fire-and-forget `pinByHash` to Pinata with the returned CID (logs on fail).
- `pinJsonToIPFS(obj, filename)` → wrap in Blob, call `pinFileToIPFS`.
- `pinDirectoryToIPFS(files, dirName)` → POST `/add` with N parts + `wrap-with-directory=true` (primary). Then `pinByHash` backup on the dir CID.
- `pinByCid(cid)` → call Lambda `/pin-cid` (primary), then Pinata `pinByHash` (backup). Same flip; today it does both but treats Pinata as primary.
- `unpinByCid(cid)` → unchanged (Pinata-only; we're only removing Pinata from the *write* path, not the cleanup path).
- Delete `alsoPinToSelfNode` — no longer needed since `/add` IS the self-node.
- `createPresignedUploadUrl()` — unused after Part C; remove.

**`src/lib/imports.server.ts`** (URL / Zoom imports) — currently Pinata-only. Rewrite to:
1. Stream source URL → S3 at `s3://{AWS_S3_INPUT_BUCKET}/imports/{uuid}` (uses existing `aws-s3.server.ts`).
2. Call existing Lambda `/pin` with that S3 key (primary).
3. `pinByHash` backup on resulting CID.
4. Best-effort delete the temp S3 object.

**HLS bundle finalize** (`src/routes/api/public/hooks/ipfs-pin-complete.ts`) — already self-node primary; add a `pinByHash` backup call after the videos row is finalized so the HLS dir CID also lives on Pinata.

**`src/routes/api/public/hooks/mediaconvert.ts` + `kickHlsPinAsync`** — same: after successful Lambda `/pin`, kick a `pinByHash` backup on the wrap CID.

### Part C — Verify

After Part A redeploy and Part B ship:
- Upload a new video → check the videos row for `transcode_status='ready'` and CID present.
- Hit `${IPFS_GATEWAY_DOMAIN}/ipfs/{cid}` directly → 200.
- Wait ~30s, then check Pinata dashboard → CID shows up in the pin queue.
- Post a comment → comment CID exists at both `${IPFS_GATEWAY_DOMAIN}/ipfs/{cid}` and `gateway.pinata.cloud/ipfs/{cid}`.
- Run `src/routes/api/public/admin/backfill-self-pins.ts` once to mirror any old Pinata-only CIDs into the self-node (so nothing in the catalog is single-homed).

### What I'm NOT touching this phase

- The `gatewayUrl()` read fallback chain — stays `IPFS_GATEWAY_DOMAIN` → `PINATA_GATEWAY_DOMAIN` → public. (Already correct.)
- `PINATA_JWT` secret — still required; it's now the backup writer + the unpin path.
- Footer copy — I'll change "pinned via pinata" to "pinned to self-hosted IPFS, backed up to Pinata" so it matches reality.

---

## Copy-paste CloudShell instructions (after I push the code)

Once the code lands and you've verified the preview deploys, open AWS CloudShell in the **us-east-1** region and run:

```bash
cd ~
curl -fsS https://streamtxc.com/txc-ipfs-deploy-v3.sh -o txc-ipfs-deploy-v3.sh
chmod +x txc-ipfs-deploy-v3.sh

# Required: same S3 bucket MediaConvert writes to
export S3_BUCKET=<your-mediaconvert-output-bucket>

# Reuse your existing VPC / subnets so the script doesn't try to make new ones
# (grab these from the previous deploy-output.env in ~/txc-ipfs)
export VPC_ID=<vpc-xxx>
export PUBLIC_SUBNET=<subnet-xxx>
export PRIVATE_SUBNET=<subnet-yyy>

# Keep Pinata backup wired in the Lambda env (same JWT as before)
export PINATA_JWT='<paste your existing PINATA_JWT>'

./txc-ipfs-deploy-v3.sh
```

The script is idempotent — it'll detect the existing stacks, only patch the Lambda code and add the new `/add` API route, then print confirmation. **No new secrets to copy back to Lovable** for this phase — the existing `IPFS_LAMBDA_URL` / `IPFS_LAMBDA_TOKEN` / `IPFS_LAMBDA_NAME` keep working with the new route.

Final smoke test in CloudShell after the script finishes:
```bash
API_URL=$(grep IPFS_LAMBDA_URL ~/txc-ipfs/deploy-output.env | cut -d= -f2)
TOKEN=$(grep IPFS_LAMBDA_TOKEN ~/txc-ipfs/deploy-output.env | cut -d= -f2)
echo "hello from streamtxc" > /tmp/hello.txt
curl -sS -X POST "$API_URL/add" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/hello.txt"
```
Expected: JSON with `cid` field. Copy that CID, then:
```bash
curl -sI "https://<your IPFS_GATEWAY_DOMAIN>/ipfs/<cid>" | head -3
```
Expected: `200 OK`.

If both pass, the redeploy worked. App-side pins will then start writing self-node first / Pinata backup automatically.