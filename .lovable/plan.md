## Goal

When a wallet is signed in, display its TXC balance next to the shortened wallet ID in the header `manage [Txx…xxx]` chip.

## Approach

1. **New server fn `getWalletBalance`** in `src/lib/wallet-balance.functions.ts`:
   - Input: `{ wallet: string }` (zod, validate non-empty).
   - Fetches `https://mempool.texitcoin.org/api/address/{wallet}` (mempool.space-compatible API). Computes `chain_stats.funded_txo_sum - chain_stats.spent_txo_sum + mempool_stats.funded_txo_sum - mempool_stats.spent_txo_sum`, divided by 1e8 → TXC.
   - Returns `{ balance: number }`. On error, returns `{ balance: null, error: string }` so the UI can degrade gracefully (show nothing instead of crashing the header).

2. **Header update** (`src/components/Header.tsx`):
   - Use `useQuery` with `queryKey: ["wallet-balance", address]`, `enabled: !!address`, `staleTime: 60_000`, `refetchInterval: 60_000`.
   - Render next to the short wallet ID inside the `manage` link:
     ```
     manage [Txx…xxx · 12.3456 TXC]
     ```
   - While loading: show `…` placeholder. On error/null: omit the balance segment silently.
   - Format with up to 4 decimals, trimmed (`balance.toFixed(4)`).

3. No DB changes, no new deps.

## Notes

- Mempool.texitcoin.org is already the canonical explorer per `txc.server.ts` comments and exposes the same REST API as mempool.space.
- The server fn keeps the upstream URL server-side (avoids CORS) and lets us swap providers later in one place.
