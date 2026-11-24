import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";
import { ADMIN_WALLET } from "./admin";
import { LIVE_PUSH_SITES, type LivePushSite } from "./live-push-rules";

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

export const listLivePushTargets = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    if (context.wallet !== ADMIN_WALLET) return { allowed: false, sites: [] };
    const { data } = await (await db()).from("live_push_targets").select("site, enabled, last_state, last_pushed_at, last_error").eq("owner_wallet", context.wallet);
    const rows = new Map<string, any>((data ?? []).map((r: any) => [r.site, r]));
    return {
      allowed: true,
      sites: (Object.keys(LIVE_PUSH_SITES) as LivePushSite[]).map((k) => {
        const r = rows.get(k);
        return {
          site: k, label: LIVE_PUSH_SITES[k].label, enabled: !!r?.enabled,
          showing: r?.last_state === "live", lastPushedAt: r?.last_pushed_at ?? null,
          problem: r?.last_error ? String(r.last_error) : null,
        };
      }),
    };
  });

export const setLivePushTarget = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((d: unknown) => z.object({ site: z.enum(["honest-money", "texitcoin"]), enabled: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    if (context.wallet !== ADMIN_WALLET) throw new Error("Only the ecosystem account can show streams on these sites.");
    const { error } = await (await db()).from("live_push_targets").upsert(
      { owner_wallet: context.wallet, site: data.site, enabled: data.enabled, updated_at: new Date().toISOString() },
      { onConflict: "owner_wallet,site" },
    );
    if (error) throw new Error("Couldn't save that.");
    return { ok: true };
  });
