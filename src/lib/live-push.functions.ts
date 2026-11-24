import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";
import { MAX_LIVE_PUSH_SITES, validatePushEndpoint, validatePushKey } from "./live-push-rules";

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

export const listLivePushSites = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const { data, error } = await (await db()).from("live_push_sites")
      .select("id, name, endpoint, key_hint, enabled, last_state, last_pushed_at, last_error")
      .eq("owner_wallet", context.wallet).order("created_at");
    if (error) throw new Error("Couldn't load your sites.");
    return {
      max: MAX_LIVE_PUSH_SITES,
      sites: (data ?? []).map((r: any) => ({
        id: String(r.id), name: String(r.name), endpoint: String(r.endpoint), keyHint: String(r.key_hint),
        enabled: !!r.enabled, showing: r.last_state === "live", problem: r.last_error ? String(r.last_error) : null,
      })),
    };
  });

export const saveLivePushSite = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((d: unknown) => z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(60),
    endpoint: z.string().max(300),
    key: z.string().max(400).optional(),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const endpoint = validatePushEndpoint(data.endpoint);
    const d = await db();
    const row: Record<string, unknown> = { name: data.name, endpoint, updated_at: new Date().toISOString() };
    if (data.key) {
      const key = validatePushKey(data.key);
      const { sealPushKey } = await import("./push-crypto.server");
      row.secret_sealed = await sealPushKey(key);
      row.key_hint = key.slice(-4);
    }
    if (data.id) {
      const { error } = await d.from("live_push_sites").update(row).eq("id", data.id).eq("owner_wallet", context.wallet);
      if (error) throw new Error("Couldn't save that site.");
    } else {
      if (!row.secret_sealed) throw new Error("Enter the site's key.");
      const { count } = await d.from("live_push_sites").select("id", { count: "exact", head: true }).eq("owner_wallet", context.wallet);
      if ((count ?? 0) >= MAX_LIVE_PUSH_SITES) throw new Error(`You can save up to ${MAX_LIVE_PUSH_SITES} sites.`);
      const { error } = await d.from("live_push_sites").insert({ ...row, owner_wallet: context.wallet, enabled: false });
      if (error) throw new Error("Couldn't save that site.");
    }
    return { ok: true };
  });

export const toggleLivePushSite = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ context, data }) => {
    const { error } = await (await db()).from("live_push_sites")
      .update({ enabled: data.enabled, updated_at: new Date().toISOString() }).eq("id", data.id).eq("owner_wallet", context.wallet);
    if (error) throw new Error("Couldn't save that.");
    return { ok: true };
  });

export const deleteLivePushSite = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const d = await db();
    const { data: r } = await d.from("live_push_sites").select("last_state").eq("id", data.id).eq("owner_wallet", context.wallet).maybeSingle();
    if (r?.last_state === "live") throw new Error("Switch it off and wait a minute so the site gets the “ended” message, then delete.");
    await d.from("live_push_sites").delete().eq("id", data.id).eq("owner_wallet", context.wallet);
    return { ok: true };
  });
