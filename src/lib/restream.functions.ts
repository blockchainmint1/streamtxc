// Host-managed extra destinations (YouTube, Facebook, Twitch…) that the
// host's own AWS live channel pushes to at the same time. Keys never leave
// the server after saving; only a 4-character hint is shown back.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";
import { ADMIN_WALLET } from "./admin";
import {
  MAX_RESTREAM_DESTINATIONS, RESTREAM_PRESETS, maskKey, validateServerUrl, validateStreamKey, withRestreamOutputs,
  type RestreamPlatform,
} from "./restream-rules";

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

async function myChannelId(wallet: string): Promise<string> {
  if (wallet === ADMIN_WALLET && process.env.MEDIALIVE_CHANNEL_ID) return process.env.MEDIALIVE_CHANNEL_ID;
  const { data } = await (await db()).from("live_channels").select("medialive_channel_id").eq("owner_wallet", wallet).maybeSingle();
  if (!data?.medialive_channel_id) throw new Error("You don't have a live channel yet — set up live streaming on the Manage page first.");
  return String(data.medialive_channel_id);
}

const Platform = z.enum(["youtube", "facebook", "twitch", "custom"]);

export const listRestreamDestinations = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const { data, error } = await (await db())
      .from("restream_destinations")
      .select("id, name, platform, server_url, key_hint, enabled, created_at")
      .eq("owner_wallet", context.wallet)
      .order("created_at");
    if (error) throw new Error("Couldn't load your destinations.");
    return { destinations: data ?? [], max: MAX_RESTREAM_DESTINATIONS };
  });

export const saveRestreamDestination = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(60),
      platform: Platform,
      serverUrl: z.string().max(300).optional(),
      streamKey: z.string().max(400).optional(),
      enabled: z.boolean().optional(),
    }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const sb = await db();
    const preset = RESTREAM_PRESETS[data.platform as RestreamPlatform];
    const serverUrl = validateServerUrl(data.serverUrl?.trim() || preset.serverUrl);
    const patch: Record<string, unknown> = {
      name: data.name, platform: data.platform, server_url: serverUrl, updated_at: new Date().toISOString(),
    };
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.streamKey?.trim()) {
      const k = validateStreamKey(data.streamKey);
      const { sealStreamKey } = await import("./restream-crypto.server");
      patch.stream_key_enc = await sealStreamKey(k);
      patch.key_hint = maskKey(k);
    }
    if (data.id) {
      const { error } = await sb.from("restream_destinations").update(patch).eq("id", data.id).eq("owner_wallet", context.wallet);
      if (error) throw new Error("Couldn't save that destination.");
      return { ok: true };
    }
    if (!patch.stream_key_enc) throw new Error("Paste the stream key for this destination.");
    const { count } = await sb.from("restream_destinations").select("id", { count: "exact", head: true }).eq("owner_wallet", context.wallet);
    if ((count ?? 0) >= MAX_RESTREAM_DESTINATIONS) throw new Error(`You can have up to ${MAX_RESTREAM_DESTINATIONS} destinations.`);
    const { error } = await sb.from("restream_destinations").insert({ ...patch, owner_wallet: context.wallet });
    if (error) throw new Error("Couldn't save that destination.");
    return { ok: true };
  });

export const deleteRestreamDestination = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await (await db()).from("restream_destinations").delete().eq("id", data.id).eq("owner_wallet", context.wallet);
    return { ok: true };
  });

/** Write the switched-on destinations into the host's AWS channel (channel must be off). */
export const applyRestreamDestinations = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const sb = await db();
    const { data: rows } = await sb
      .from("restream_destinations")
      .select("server_url, stream_key_enc")
      .eq("owner_wallet", context.wallet)
      .eq("enabled", true)
      .order("created_at");
    const { openStreamKey } = await import("./restream-crypto.server");
    const targets: { serverUrl: string; streamKey: string }[] = [];
    for (const r of (rows ?? []).slice(0, MAX_RESTREAM_DESTINATIONS)) {
      targets.push({ serverUrl: validateServerUrl(r.server_url), streamKey: await openStreamKey(r.stream_key_enc) });
    }
    const channelId = await myChannelId(context.wallet);
    const ml = await import("./aws-medialive.server");
    await ml.updateChannelRestream(channelId, (dest, encSettings) => withRestreamOutputs(dest, encSettings, targets));
    return { ok: true, count: targets.length };
  });
