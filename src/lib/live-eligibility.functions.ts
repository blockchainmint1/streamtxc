// Phase A of the multi-user livestreaming rollout: admin-only server fns to
// flip the `live_eligible` flag (and optional per-wallet rate override) on
// `wallet_notification_prefs`. Every write is gated by the wallet-session
// middleware and checked against the hard-coded ADMIN_WALLET — same pattern
// as bug_reports_admin. Never trust the caller's own wallet input; the
// verified wallet on `context.wallet` is authoritative.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";

const ADMIN_WALLET = "Thaotk2YYWiXG9EozU5dqABx7EB26fGrhn";

function assertAdmin(wallet: string) {
  if (wallet !== ADMIN_WALLET) {
    throw new Error("Forbidden");
  }
}

const walletSchema = z
  .string()
  .trim()
  .regex(
    /^T[1-9A-HJ-NP-Za-km-z]{20,90}$/,
    "Wallet must be a legacy TXC address starting with T",
  );

/**
 * Admin: list every wallet with eligibility currently on, plus any wallets
 * that have an explicit rate override even if disabled. Small result set,
 * safe to send in full to the admin UI.
 */
export const listLiveEligibleWallets = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    assertAdmin(context.wallet);
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_notification_prefs")
      .select(
        "wallet, live_eligible, live_rate_txc_per_minute, live_max_concurrent_minutes, updated_at",
      )
      .or(
        "live_eligible.eq.true,live_rate_txc_per_minute.not.is.null",
      )
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{
      wallet: string;
      live_eligible: boolean;
      live_rate_txc_per_minute: string | null;
      live_max_concurrent_minutes: number;
      updated_at: string;
    }>;
  });

/**
 * Admin: upsert the eligibility row for a target wallet. Null/undefined
 * rate means "use the global default" (`LIVE_DEFAULT_RATE_TXC_PER_MIN`).
 */
export const setLiveEligibility = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        targetWallet: walletSchema,
        live_eligible: z.boolean(),
        live_rate_txc_per_minute: z
          .number()
          .positive()
          .max(1_000_000)
          .nullable()
          .optional(),
        live_max_concurrent_minutes: z
          .number()
          .int()
          .min(5)
          .max(24 * 60)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    assertAdmin(context.wallet);
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const patch: Record<string, unknown> = {
      wallet: data.targetWallet,
      live_eligible: data.live_eligible,
    };
    if (data.live_rate_txc_per_minute !== undefined) {
      patch.live_rate_txc_per_minute = data.live_rate_txc_per_minute;
    }
    if (data.live_max_concurrent_minutes !== undefined) {
      patch.live_max_concurrent_minutes = data.live_max_concurrent_minutes;
    }
    const { error } = await (supabaseAdmin as any)
      .from("wallet_notification_prefs")
      .upsert(patch, { onConflict: "wallet" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Public-ish: for the signed-in wallet, report whether they may broadcast a
 * livestream and (if so) which rate applies. Used by /manage to decide
 * whether to render the Go Live section for a normal user.
 */
export const getMyLiveEligibility = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_notification_prefs")
      .select(
        "live_eligible, live_rate_txc_per_minute, live_max_concurrent_minutes",
      )
      .eq("wallet", context.wallet)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = (data ?? null) as {
      live_eligible: boolean;
      live_rate_txc_per_minute: string | null;
      live_max_concurrent_minutes: number;
    } | null;
    const defaultRate = Number(
      process.env.LIVE_DEFAULT_RATE_TXC_PER_MIN ?? "0",
    );
    const rate = row?.live_rate_txc_per_minute
      ? Number(row.live_rate_txc_per_minute)
      : defaultRate;
    return {
      eligible: !!row?.live_eligible,
      rateTxcPerMinute: rate,
      maxConcurrentMinutes: row?.live_max_concurrent_minutes ?? 240,
    };
  });