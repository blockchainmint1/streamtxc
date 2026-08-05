---
name: IPFS gateway fallback policy
description: All IPFS gateway and pin operations must use the self-hosted node only; third-party gateway fallbacks are forbidden.
type: constraint
---
`/api/stream/$cid` and `/api/stream/$cid/$` must use the self-hosted node (`IPFS_GATEWAY_DOMAIN`, default `ipfs.honest.money`) exclusively. Never add a third-party gateway fallback, package, domain, or secret.

**Why:** the self-hosted node is primary for cost/independence, but a newly-pinned CID is sometimes missing from it (Lambda `/add` race, mirror lag, manual pin not yet run). Without the fallback the player's `<img>`/HLS request hangs and the UI silently shows the prior browser-cached image (or black). Confirmed root cause of the "thumbnail edit doesn't show" bug on 2026-06-19.

**Don't:** replace `resolveGatewayUrl` with the synchronous `gatewayUrl` to "save a HEAD request". The probe is ~1.5 s worst case and only fires when the self-node is unreachable; on a hit it's a few ms.