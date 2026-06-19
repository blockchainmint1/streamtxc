---
name: IPFS gateway fallback policy
description: /api/stream/* must HEAD-probe the self-hosted IPFS node and fall through to Pinata on miss; don't remove the fallback.
type: constraint
---
`/api/stream/$cid` and `/api/stream/$cid/$` redirect to the IPFS gateway. They MUST go through `resolveGatewayUrl(cid)` in `src/lib/pinata.server.ts`, which HEAD-probes the self-hosted node (`IPFS_GATEWAY_DOMAIN`, e.g. `ipfs.honest.money`) with a short timeout and falls back to Pinata (`PINATA_GATEWAY_DOMAIN` or `gateway.pinata.cloud`) on miss/timeout.

**Why:** the self-hosted node is primary for cost/independence, but a newly-pinned CID is sometimes missing from it (Lambda `/add` race, mirror lag, manual pin not yet run). Without the fallback the player's `<img>`/HLS request hangs and the UI silently shows the prior browser-cached image (or black). Confirmed root cause of the "thumbnail edit doesn't show" bug on 2026-06-19.

**Don't:** replace `resolveGatewayUrl` with the synchronous `gatewayUrl` to "save a HEAD request". The probe is ~1.5 s worst case and only fires when the self-node is unreachable; on a hit it's a few ms.