import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { pinFileToIPFS } from "./pinata.server";
import { timestampCid, mockPaymentTx } from "./chain";
import { quoteFee, MAX_UPLOAD_BYTES } from "./fees";

const walletSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address");

// --- Quote -----------------------------------------------------------------

export const getQuote = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
        months: z.number().int().min(1).max(12).default(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    return {
      txcAmount: quoteFee(data.sizeBytes, data.months),
      months: data.months,
      sizeBytes: data.sizeBytes,
    };
  });

// --- Upload + pin + timestamp ---------------------------------------------

export const finalizeUpload = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        months: z.number().int().min(1).max(12).default(1),
        // Base64-encoded file (for MVP < 100MB).
        fileBase64: z.string().min(1),
        filename: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // Decode base64 → Blob
    const binary = Uint8Array.from(atob(data.fileBase64), (c) =>
      c.charCodeAt(0),
    );
    if (binary.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`File exceeds ${MAX_UPLOAD_BYTES} byte limit`);
    }
    const blob = new Blob([binary as BlobPart], { type: data.mimeType });

    // 1. Pin to IPFS via Pinata
    const pin = await pinFileToIPFS(blob, data.filename);

    // 2. Mock payment + on-chain timestamp
    const fee = quoteFee(binary.byteLength, data.months);
    const paymentTx = mockPaymentTx(data.wallet, fee);
    const stamp = timestampCid(pin.cid, data.wallet, binary.byteLength);

    // 3. Persist
    const expires = new Date();
    expires.setMonth(expires.getMonth() + data.months);

    const { error: vErr } = await supabaseAdmin
      .from("videos")
      .upsert({
        cid: pin.cid,
        owner_wallet: data.wallet,
        title: data.title,
        description: data.description || null,
        size_bytes: binary.byteLength,
        mime_type: data.mimeType,
        status: "active",
        mock_tx_hash: stamp.txHash,
        mock_block_number: stamp.blockNumber,
        months_prepaid: data.months,
        expires_at: expires.toISOString(),
      });
    if (vErr) throw new Error(`Failed to save video: ${vErr.message}`);

    const { error: pErr } = await supabaseAdmin.from("payments").insert({
      video_cid: pin.cid,
      wallet: data.wallet,
      txc_amount: fee,
      months_prepaid: data.months,
      mock_tx_hash: paymentTx,
    });
    if (pErr) throw new Error(`Failed to save payment: ${pErr.message}`);

    return {
      cid: pin.cid,
      txHash: stamp.txHash,
      blockNumber: stamp.blockNumber,
      explorerUrl: stamp.explorerUrl,
      paymentTx,
      txcAmount: fee,
    };
  });

// --- Listings --------------------------------------------------------------

export const listRecentVideos = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data, error } = await supabaseAdmin
      .from("videos")
      .select(
        "cid, title, owner_wallet, size_bytes, view_count, created_at, status",
      )
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(24);
    if (error) throw new Error(error.message);
    return data ?? [];
  },
);

export const getVideo = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ cid: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select("*")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return video;
  });

export const listMyVideos = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ wallet: walletSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: videos, error } = await supabaseAdmin
      .from("videos")
      .select("*")
      .eq("owner_wallet", data.wallet)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return videos ?? [];
  });

// --- View tracking (called by stream proxy) -------------------------------

export async function recordView(cid: string, ipHash: string) {
  // Debounce: only count if this IP hasn't viewed in last 30s.
  const since = new Date(Date.now() - 30_000).toISOString();
  const { data: recent } = await supabaseAdmin
    .from("view_events")
    .select("id")
    .eq("video_cid", cid)
    .eq("ip_hash", ipHash)
    .gte("ts", since)
    .limit(1);

  if (recent && recent.length > 0) return false;

  await supabaseAdmin.from("view_events").insert({
    video_cid: cid,
    ip_hash: ipHash,
  });

  // Increment counter + accrue creator credit.
  const { data: video } = await supabaseAdmin
    .from("videos")
    .select("view_count, owner_wallet")
    .eq("cid", cid)
    .maybeSingle();
  if (!video) return false;

  await supabaseAdmin
    .from("videos")
    .update({ view_count: (video.view_count ?? 0) + 1 })
    .eq("cid", cid);

  // Reward credit.
  const { data: existing } = await supabaseAdmin
    .from("creator_credits")
    .select("credits")
    .eq("wallet", video.owner_wallet)
    .maybeSingle();

  const newCredits = (Number(existing?.credits) || 0) + 0.001;
  await supabaseAdmin
    .from("creator_credits")
    .upsert({
      wallet: video.owner_wallet,
      credits: newCredits,
      updated_at: new Date().toISOString(),
    });

  return true;
}