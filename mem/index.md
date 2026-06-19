# Project Memory

## Core
IPFS: `/api/stream/*` must use `resolveGatewayUrl()` — self-node first, Pinata fallback. Never swap back to bare `gatewayUrl()`.

## Memories
- [Streaming/CDN research links](mem://references/streaming-cdn-research) — Bunny Stream, EdgeNext CDN, IPFS streaming article
- [IPFS gateway fallback](mem://constraints/ipfs-gateway-fallback) — /api/stream/* HEAD-probes self-node, falls through to Pinata on miss