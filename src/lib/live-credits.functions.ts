// Phase C of multi-user livestreaming: TXC/minute prepaid credit ledger.
// A wallet must hold a positive balance before startMyStream will call
// startChannel. The billing tick (src/routes/api/public/hooks/live-billing-tick.ts)
// consumes 1 minute × rate per running channel and stops it when balance
// falls below one minute.

import { createServerFn } from "@tanstack/react-start";
import { requireWalletSession } from "./wallet-auth.functions";

export function defaultRatePerMin(): number {
  const raw = process.env.LIVE_DEFAULT_RATE_TXC_PER_MIN ?? "0.5";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

export async function getWalletRatePerMin(wallet: string): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("wallet_notification_prefs")
    .select("live_rate_txc_per_minute")
    .eq("wallet", wallet)
    .maybeSingle();
  const override = data?.live_rate_txc_per_minute;
  if (override != null) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return defaultRatePerMin();
}

export async function computeBalance(wallet: string): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any)
    .from("live_credit_ledger")
    .select("delta_txc")
    .eq("wallet", wallet);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ delta_txc: number | string }>;
  return rows.reduce((sum, r) => sum + Number(r.delta_txc), 0);
}

/**
 * Ensure the wallet has a dedicated on-chain deposit address minted from
 * the platform node. We reuse the video-wallet derivation pool so every
 * address on the node has a unique label + traceable index.
 */
async function ensureDepositAddress(wallet: string): Promise<{
  address: string;
  derivationIndex: number | null;
  receivedTxc: number;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing } = await (supabaseAdmin as any)
    .from("wallet_notification_prefs")
    .select("live_deposit_address, live_deposit_derivation_index, live_deposit_received_txc")
    .eq("wallet", wallet)
    .maybeSingle();
  if (existing?.live_deposit_address) {
    return {
      address: existing.live_deposit_address as string,
      derivationIndex: existing.live_deposit_derivation_index ?? null,
      receivedTxc: Number(existing.live_deposit_received_txc ?? 0),
    };
  }
  const { assignVideoWallet } = await import("./txc-wallets.server");
  const w = await assignVideoWallet();
  await (supabaseAdmin as any)
    .from("wallet_notification_prefs")
    .upsert(
      {
        wallet,
        live_deposit_address: w.address,
        live_deposit_derivation_index: w.derivationIndex,
      },
      { onConflict: "wallet" },
    );
  return { address: w.address, derivationIndex: w.derivationIndex, receivedTxc: 0 };
}

/**
 * Pull the total received on the wallet's deposit address from the chain
 * and credit any delta into the ledger as a deposit row. Called from the
 * billing tick and from user-facing balance reads.
 */
export async function syncDepositsForWallet(wallet: string): Promise<{ credited: number }> {
  const info = await ensureDepositAddress(wallet);
  const { getAddressReceived } = await import("./txc.server");
  let received: number;
  try {
    received = await getAddressReceived(info.address);
  } catch {
    return { credited: 0 };
  }
  const prev = info.receivedTxc;
  const delta = +(received - prev).toFixed(8);
  if (delta <= 0) return { credited: 0 };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await (supabaseAdmin as any).from("live_credit_ledger").insert({
    wallet,
    delta_txc: delta,
    kind: "deposit",
    note: `deposit ${info.address}`,
  });
  await (supabaseAdmin as any)
    .from("wallet_notification_prefs")
    .update({ live_deposit_received_txc: received })
    .eq("wallet", wallet);
  return { credited: delta };
}

// ---------- Server functions (user-facing) ----------

export const getMyLiveBalance = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    await syncDepositsForWallet(context.wallet).catch(() => null);
    const [balance, rate] = await Promise.all([
      computeBalance(context.wallet),
      getWalletRatePerMin(context.wallet),
    ]);
    const minutes = rate > 0 ? Math.floor(balance / rate) : 0;
    return {
      balanceTxc: +balance.toFixed(8),
      ratePerMin: rate,
      estimatedMinutes: minutes,
    };
  });

export const getMyLiveDepositInfo = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const info = await ensureDepositAddress(context.wallet);
    const rate = await getWalletRatePerMin(context.wallet);
    return { address: info.address, ratePerMin: rate };
  });

export const listMyLiveLedger = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("live_credit_ledger")
      .select("id, delta_txc, kind, stream_id, txid, note, created_at")
      .eq("wallet", context.wallet)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  });