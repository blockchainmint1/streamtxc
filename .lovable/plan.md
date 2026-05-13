## Goal

Update the `txc-ipfs-ingest` service so it's ready to deploy on your AWS box, talking to your real cluster and gateway. **No changes to the live site** — that wiring is parked until you've deployed and tested the ingest box.

## Changes to the ingest zip

1. **Cluster auth: Bearer → Basic** in `src/cluster.js`.
   - Replace `CLUSTER_TOKEN` with `CLUSTER_BASIC_USER` + `CLUSTER_BASIC_PASS`.
   - Build `Authorization: Basic base64(user:pass)` on every cluster request.

2. **Updated `.env.example`** with your real values pre-filled as defaults:
   - `CLUSTER_API_URL=https://IpfsCluster-LoadBalancer-571793241.us-east-1.elb.amazonaws.com:9094`
   - `CLUSTER_BASIC_USER=bevis_backend_live`
   - `CLUSTER_BASIC_PASS=…` (from the curl)
   - `PUBLIC_GATEWAY_URL=https://ipfs.blockchainmint.com/ipfs/`
   - `PINATA_JWT=…` (mirror)
   - `INGEST_TOKEN=…` (you generate; this is what the site will use later)
   - `ALLOWED_ORIGINS=https://stream.texitcoin.org,https://txc-stream.lovable.app`

3. **Cluster `/add` query params** stay `cid-version=1&raw-leaves=true` so CIDs match what Pinata generates. Send the **transcoded** MP4, not the original, when ffmpeg ran.

4. **Pinata mirror** stays fire-and-forget after a successful cluster pin — keeps Pinata as a warm backup automatically.

5. **TLS / proxy notes**: the cluster ELB uses an AWS-issued cert on its `*.elb.amazonaws.com` hostname; Node trusts it out of the box, no extra CA work.

6. **Nginx sample** (`nginx/ingest.conf.example`): 5 GB body limit, long read/send timeouts (transcoding can take minutes), CORS allowlist matching `ALLOWED_ORIGINS`.

7. **README** updated end-to-end: deploy steps, env vars, a `curl` against `/v1/upload` and `/v1/pin` so you can smoke-test before the site is involved.

## Deliverable

`txc-ipfs-ingest_v2.zip`. You deploy it, hit it with the README curl commands to confirm it transcodes + pins + mirrors, then send me back the public URL + the `INGEST_TOKEN` you chose. At that point we'll do Part B (site wiring) as a separate plan.

## Open items for you (not blocking the zip, but blocking real use)

- Confirm `https://ipfs.blockchainmint.com/ipfs/<cid>` serves a known test CID in a normal browser, returns `Accept-Ranges: bytes`, and has CORS open enough for `<video>` seeking from the site origin.
- Confirm whatever box you deploy the ingest service on can reach `:9094` on the cluster ELB (security group / VPC).
