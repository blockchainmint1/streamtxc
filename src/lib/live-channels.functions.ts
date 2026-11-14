// Phase B of multi-user livestreaming: per-wallet MediaLive + MediaPackage
// provisioning, start/stop, and RTMP config lookup. All calls are gated by
// requireWalletSession + a `live_eligible` check on wallet_notification_prefs.
// Never trust an input `wallet` — always use `context.wallet`.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession } from "./wallet-auth.functions";
import { newStreamKey, isWeakStreamKey } from "./security-limits";

function parseRtmp(fullUrl: string): { serverUrl: string; streamKey: string } {
  const m = fullUrl.match(/^(rtmps?:\/\/[^/]+\/[^/]+)\/([^/?#]+)$/i);
  if (m) return { serverUrl: m[1], streamKey: m[2] };
  const idx = fullUrl.lastIndexOf("/");
  if (idx > "rtmp://".length) {
    return { serverUrl: fullUrl.slice(0, idx), streamKey: fullUrl.slice(idx + 1) };
  }
  return { serverUrl: fullUrl, streamKey: "" };
}

async function loadEligibility(wallet: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any)
    .from("wallet_notification_prefs")
    .select("live_eligible, live_max_concurrent_minutes")
    .eq("wallet", wallet)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.live_eligible) throw new Error("Your wallet is not enabled for livestreaming.");
  return {
    maxMinutes: (data.live_max_concurrent_minutes ?? 240) as number,
  };
}

async function getMyChannelRow(wallet: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any)
    .from("live_channels")
    .select("*")
    .eq("owner_wallet", wallet)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as any;
}

function shortId(wallet: string) {
  // MediaLive names/IDs must be short and [A-Za-z0-9_-]. Use a stable hash-ish slice.
  return "w-" + wallet.slice(1, 9).toLowerCase() + "-" + wallet.slice(-6).toLowerCase();
}

// ---------- Reads ----------

export const getMyLiveChannel = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const row = await getMyChannelRow(context.wallet);
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      rtmpUrl: row.rtmp_url,
      streamKey: row.stream_key,
      weakStreamKey: isWeakStreamKey(row.stream_key),
      hlsUrl: row.hls_url,
      medialiveChannelId: row.medialive_channel_id,
      lastUsedAt: row.last_used_at,
      provisionedAt: row.provisioned_at,
    };
  });

export const describeMyChannelState = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const row = await getMyChannelRow(context.wallet);
    if (!row) return { state: "NOT_PROVISIONED" as const };
    const { describeChannel } = await import("./aws-medialive.server");
    try {
      const info = await describeChannel(row.medialive_channel_id);
      return { state: info.state, channelId: row.medialive_channel_id };
    } catch (err) {
      return {
        state: "UNKNOWN",
        error: err instanceof Error ? err.message : "describe failed",
      };
    }
  });

export const getMySignalHealth = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const row = await getMyChannelRow(context.wallet);
    if (!row?.hls_url) return { ok: false as const, reason: "No channel provisioned" };
    try {
      const res = await fetch(row.hls_url, { method: "GET", cache: "no-store" });
      const seqRaw = res.headers.get("x-mediapackage-manifest-last-sequence");
      const updatedRaw = res.headers.get("x-mediapackage-manifest-last-updated");
      const lastSequence = seqRaw ? Number(seqRaw) : 0;
      const lastUpdatedMs = updatedRaw ? Number(updatedRaw) * 1000 : 0;
      const ageSec = lastUpdatedMs ? Math.round((Date.now() - lastUpdatedMs) / 1000) : null;
      return {
        ok: true as const,
        status: res.status,
        lastSequence,
        ageSec,
        receiving: res.status === 200 && ageSec !== null && ageSec < 30,
      };
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : "probe failed" };
    }
  });

// ---------- Provisioning ----------

export const provisionMyLiveChannel = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    await loadEligibility(context.wallet);

    const existing = await getMyChannelRow(context.wallet);
    if (existing) return { alreadyProvisioned: true, id: existing.id };

    const roleArn = process.env.MEDIALIVE_CHANNEL_ROLE_ARN;
    const sgId = process.env.MEDIALIVE_INPUT_SECURITY_GROUP_ID; // may be stale / missing; resolved below
    const archiveBucket = process.env.LIVE_ARCHIVE_BUCKET;
    if (!roleArn) throw new Error("MEDIALIVE_CHANNEL_ROLE_ARN not configured");
    if (!archiveBucket) throw new Error("LIVE_ARCHIVE_BUCKET not configured");

    const slug = shortId(context.wallet);
    const archivePrefix = `per-user/${slug}`;

    const {
      createRtmpInput,
      createMediaLiveChannel,
      createMediaPackageChannel,
      createHlsOriginEndpoint,
      deleteInput,
      deleteMediaPackageChannel,
      deleteHlsOriginEndpoint,
      ensureInputSecurityGroup,
    } = await import("./aws-medialive.server");
    const { ENCODER_SETTINGS, INPUT_SPECIFICATION, buildChannelDestinations } = await import(
      "./medialive-encoder-template"
    );

    let mpChannelId: string | null = null;
    let mpEndpointId: string | null = null;
    let inputId: string | null = null;
    let hlsUrl = "";
    try {
      const mp = await createMediaPackageChannel(`mp-${slug}`);
      mpChannelId = mp.channelId;
      const ep = await createHlsOriginEndpoint({ id: `hls-${slug}`, channelId: mpChannelId });
      mpEndpointId = ep.endpointId;
      hlsUrl = ep.url;

      const resolvedSg = await ensureInputSecurityGroup(sgId);
      const inp = await createRtmpInput({
        name: `${slug}-rtmp`,
        streamName: `${slug}/${newStreamKey()}`,
        securityGroupId: resolvedSg,
      });
      inputId = inp.inputId;
      const fullRtmp = inp.destinations[0] ?? "";
      const { serverUrl, streamKey } = parseRtmp(fullRtmp);

      const ch = await createMediaLiveChannel({
        name: `${slug}-channel`,
        roleArn,
        inputId,
        inputSpecification: INPUT_SPECIFICATION,
        destinations: buildChannelDestinations({
          mediaPackageChannelId: mpChannelId,
          archiveBucket,
          archivePrefix,
        }),
        encoderSettings: ENCODER_SETTINGS,
      });

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: row, error } = await (supabaseAdmin as any)
        .from("live_channels")
        .insert({
          owner_wallet: context.wallet,
          medialive_channel_id: ch.channelId,
          medialive_input_id: inputId,
          mediapackage_channel_id: mpChannelId,
          mediapackage_endpoint_id: mpEndpointId,
          rtmp_url: serverUrl,
          stream_key: streamKey,
          hls_url: hlsUrl,
          archive_prefix: archivePrefix,
          status: "idle",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { alreadyProvisioned: false, id: row.id };
    } catch (err) {
      // Best-effort rollback so a half-provisioned setup doesn't rack up cost.
      if (inputId) await deleteInput(inputId).catch(() => null);
      if (mpEndpointId) await deleteHlsOriginEndpoint(mpEndpointId).catch(() => null);
      if (mpChannelId) await deleteMediaPackageChannel(mpChannelId).catch(() => null);
      throw err;
    }
  });

/** Replace this wallet's stream key with a new random one (channel must be off). */
export const rotateMyStreamKey = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const row = await getMyChannelRow(context.wallet);
    if (!row?.medialive_input_id || !row?.medialive_channel_id) {
      throw new Error("No live channel set up yet.");
    }
    const { rotateRtmpStreamKey } = await import("./aws-medialive.server");
    const next = await rotateRtmpStreamKey({
      inputId: row.medialive_input_id,
      channelId: row.medialive_channel_id,
      newKey: newStreamKey(),
    });
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("live_channels")
      .update({ rtmp_url: next.serverUrl, stream_key: next.streamKey })
      .eq("id", row.id);
    if (error) throw new Error(error.message);
    return { rtmpUrl: next.serverUrl, streamKey: next.streamKey };
  });

// ---------- Start / stop ----------

export const startMyStream = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).optional().nullable(),
        thumbnail_cid: z.string().trim().max(120).optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await loadEligibility(context.wallet);
    const row = await getMyChannelRow(context.wallet);
    if (!row) throw new Error("No channel provisioned. Click Enable live first.");

    // Preflight: require at least 5 minutes of TXC credit on the balance.
    const { syncDepositsForWallet, computeBalance, getWalletRatePerMin } = await import(
      "./live-credits.functions"
    );
    await syncDepositsForWallet(context.wallet).catch(() => null);
    const [balance, rate] = await Promise.all([
      computeBalance(context.wallet),
      getWalletRatePerMin(context.wallet),
    ]);
    if (balance < rate * 5) {
      const need = +(rate * 5 - balance).toFixed(4);
      throw new Error(
        `Not enough live credit. You need at least ${(rate * 5).toFixed(4)} TXC (${need} TXC more) to start a stream.`,
      );
    }

    // Concurrency cap: refuse if the account is already at LIVE_MAX_CHANNELS_RUNNING.
    const cap = Number(process.env.LIVE_MAX_CHANNELS_RUNNING ?? "3");
    const { listRunningChannelIds, describeChannel, startChannel } = await import(
      "./aws-medialive.server"
    );
    const running = await listRunningChannelIds().catch(() => [] as string[]);
    if (!running.includes(row.medialive_channel_id) && running.length >= cap) {
      throw new Error(
        `Livestream capacity reached (${running.length}/${cap} channels running). Try again in a few minutes.`,
      );
    }

    const current = await describeChannel(row.medialive_channel_id).catch(() => null);
    if (!current || (current.state !== "RUNNING" && current.state !== "STARTING")) {
      await startChannel(row.medialive_channel_id);
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: stream, error } = await (supabaseAdmin as any)
      .from("live_streams")
      .insert({
        title: data.title,
        description: data.description || null,
        thumbnail_cid: data.thumbnail_cid || null,
        owner_wallet: context.wallet,
        medialive_channel_id: row.medialive_channel_id,
        hls_url: row.hls_url,
        channel_row_id: row.id,
        status: "starting",
        started_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await (supabaseAdmin as any)
      .from("live_channels")
      .update({ status: "starting", last_used_at: new Date().toISOString() })
      .eq("id", row.id);

    return { streamId: stream.id };
  });

export const stopMyStream = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) => z.object({ streamId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const row = await getMyChannelRow(context.wallet);
    if (!row) throw new Error("No channel provisioned.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: stream } = await (supabaseAdmin as any)
      .from("live_streams")
      .select("id, owner_wallet")
      .eq("id", data.streamId)
      .maybeSingle();
    if (!stream || stream.owner_wallet !== context.wallet) throw new Error("Not found");

    const { stopChannel } = await import("./aws-medialive.server");
    await stopChannel(row.medialive_channel_id).catch((err) => {
      console.warn("[live] stopChannel failed", err);
    });
    await (supabaseAdmin as any)
      .from("live_streams")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", data.streamId);
    await (supabaseAdmin as any)
      .from("live_channels")
      .update({ status: "idle" })
      .eq("id", row.id);
    return { ok: true };
  });

export const markMyStreamLive = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) => z.object({ streamId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: stream } = await (supabaseAdmin as any)
      .from("live_streams")
      .select("id, owner_wallet")
      .eq("id", data.streamId)
      .maybeSingle();
    if (!stream || stream.owner_wallet !== context.wallet) throw new Error("Not found");
    const { error } = await (supabaseAdmin as any)
      .from("live_streams")
      .update({ status: "live" })
      .eq("id", data.streamId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listMyLiveStreams = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("live_streams")
      .select("*")
      .eq("owner_wallet", context.wallet)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return (data ?? []) as any[];
  });