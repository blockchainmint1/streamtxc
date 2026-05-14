// Fetch a TXC wallet balance from mempool.texitcoin.org. The mempool API
// is mempool.space-compatible: GET /api/address/{addr} returns
// { chain_stats, mempool_stats } in satoshis. We do this server-side to
// dodge CORS and to keep the upstream URL swappable.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

interface AddressStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
}
interface AddressInfo {
  chain_stats: AddressStats;
  mempool_stats: AddressStats;
}

export const getWalletBalance = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({ wallet: z.string().trim().min(4).max(120) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    try {
      const res = await fetch(
        `https://mempool.texitcoin.org/api/address/${encodeURIComponent(data.wallet)}`,
        { headers: { accept: "application/json" } },
      );
      if (!res.ok) {
        return { balance: null as number | null, error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as AddressInfo;
      const sats =
        json.chain_stats.funded_txo_sum -
        json.chain_stats.spent_txo_sum +
        json.mempool_stats.funded_txo_sum -
        json.mempool_stats.spent_txo_sum;
      return { balance: sats / 1e8, error: null as string | null };
    } catch (err) {
      return {
        balance: null as number | null,
        error: err instanceof Error ? err.message : "lookup failed",
      };
    }
  });