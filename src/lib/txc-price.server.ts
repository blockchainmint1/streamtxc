// Live TXC/USD spot price with an in-memory cache.
// Source: CoinGecko (`texitcoin` ID — confirmed via /coins/list).
// Cached for 5 minutes per worker isolate so we don't hammer the API.

import { FALLBACK_TXC_USD } from "./fees";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { price: number; at: number } | null = null;

export interface TxcPrice {
  usd: number;
  source: "live" | "cache" | "fallback";
  fetchedAt: string;
}

export async function getTxcUsdPrice(): Promise<TxcPrice> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { usd: cache.price, source: "cache", fetchedAt: new Date(cache.at).toISOString() };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=texitcoin&vs_currencies=usd",
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = (await res.json()) as { texitcoin?: { usd?: number } };
    const usd = j.texitcoin?.usd;
    if (typeof usd !== "number" || usd <= 0) throw new Error("no price");
    cache = { price: usd, at: now };
    return { usd, source: "live", fetchedAt: new Date(now).toISOString() };
  } catch (err) {
    console.warn("TXC price fetch failed, using fallback:", (err as Error).message);
    if (cache) {
      return { usd: cache.price, source: "cache", fetchedAt: new Date(cache.at).toISOString() };
    }
    return { usd: FALLBACK_TXC_USD, source: "fallback", fetchedAt: new Date(now).toISOString() };
  }
}
