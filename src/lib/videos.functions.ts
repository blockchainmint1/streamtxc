import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { pinFileToIPFS, createPresignedUploadUrl, pinByCid } from "./pinata.server";
import { mockPaymentTx } from "./chain";
import { stampCid, getTxStatus, explorerTxUrl } from "./txc.server";
import { quoteFee, MAX_UPLOAD_BYTES } from "./fees";

const walletSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address");

/**
 * If a video with this CID already exists, throw a structured error the
 * client can parse to show a friendly "already claimed" panel.
 */
async function assertCidUnclaimed(cid: string) {
  const { data: existing } = await supabaseAdmin
    .from("videos")
    .select("cid, owner_wallet, title, created_at, tx_hash")
    .eq("cid", cid)
    .maybeSingle();
  if (existing) {
    throw new Error(
      "DUPLICATE_CID:" +
        JSON.stringify({
          cid: existing.cid,
          ownerWallet: existing.owner_wallet,
          title: existing.title,
          createdAt: existing.created_at,
          txHash: existing.tx_hash,
        }),
    );
  }
}

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

// --- Direct browser → Pinata upload ---------------------------------------

/** Step 1: get a presigned URL the browser can POST the file to. */
export const getUploadUrl = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        filename: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    return await createPresignedUploadUrl({ filename: data.filename });
  });

/** Step 2: after the browser uploads, persist metadata + mock payment. */
export const registerUpload = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        cid: z
          .string()
          .trim()
          .regex(
            /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{50,})$/,
            "Invalid CID",
          ),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
        mimeType: z.string().min(1).max(100),
        months: z.number().int().min(1).max(12).default(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await assertCidUnclaimed(data.cid);
    const fee = quoteFee(data.sizeBytes, data.months);
    const paymentTx = mockPaymentTx(data.wallet, fee);
    const stamp = await stampCid(data.cid, data.wallet);

    const expires = new Date();
    expires.setMonth(expires.getMonth() + data.months);

    const { error: vErr } = await supabaseAdmin.from("videos").insert({
      cid: data.cid,
      owner_wallet: data.wallet,
      title: data.title,
      description: data.description || null,
      size_bytes: data.sizeBytes,
      mime_type: data.mimeType,
      status: "mempool",
      tx_hash: stamp.txid,
      op_return_payload: stamp.payload,
      months_prepaid: data.months,
      expires_at: expires.toISOString(),
    });
    if (vErr) {
      // Race condition: someone registered the same CID between our check
      // and the insert. Re-run the duplicate check to surface a friendly error.
      if (vErr.code === "23505") await assertCidUnclaimed(data.cid);
      throw new Error(`Failed to save video: ${vErr.message}`);
    }

    const { error: pErr } = await supabaseAdmin.from("payments").insert({
      video_cid: data.cid,
      wallet: data.wallet,
      txc_amount: fee,
      months_prepaid: data.months,
      mock_tx_hash: paymentTx,
    });
    if (pErr) throw new Error(`Failed to save payment: ${pErr.message}`);

    return {
      cid: data.cid,
      txHash: stamp.txid,
      explorerUrl: explorerTxUrl(stamp.txid),
      paymentTx,
      txcAmount: fee,
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

    // Reject duplicates BEFORE we stamp the chain.
    await assertCidUnclaimed(pin.cid);

    // 2. Mock payment + real on-chain stamp
    const fee = quoteFee(binary.byteLength, data.months);
    const paymentTx = mockPaymentTx(data.wallet, fee);
    const stamp = await stampCid(pin.cid, data.wallet);

    // 3. Persist
    const expires = new Date();
    expires.setMonth(expires.getMonth() + data.months);

    const { error: vErr } = await supabaseAdmin
      .from("videos")
      .insert({
        cid: pin.cid,
        owner_wallet: data.wallet,
        title: data.title,
        description: data.description || null,
        size_bytes: binary.byteLength,
        mime_type: data.mimeType,
        status: "mempool",
        tx_hash: stamp.txid,
        op_return_payload: stamp.payload,
        months_prepaid: data.months,
        expires_at: expires.toISOString(),
      });
    if (vErr) {
      if (vErr.code === "23505") await assertCidUnclaimed(pin.cid);
      throw new Error(`Failed to save video: ${vErr.message}`);
    }

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
      txHash: stamp.txid,
      explorerUrl: explorerTxUrl(stamp.txid),
      paymentTx,
      txcAmount: fee,
    };
  });

// --- Add an existing IPFS CID (no re-upload) ------------------------------

const cidSchema = z
  .string()
  .trim()
  .min(46)
  .max(120)
  .regex(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{50,})$/, "Invalid IPFS CID");

export const addByCid = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        cid: cidSchema,
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        months: z.number().int().min(1).max(12).default(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // Reject if already registered (with structured details for the UI)
    await assertCidUnclaimed(data.cid);

    // Probe the gateway to learn size + mime (HEAD, then ranged GET fallback)
    const gatewayDomain = process.env.PINATA_GATEWAY_DOMAIN;
    const url = gatewayDomain
      ? `https://${gatewayDomain}/ipfs/${data.cid}`
      : `https://gateway.pinata.cloud/ipfs/${data.cid}`;

    let sizeBytes = 0;
    let mimeType = "video/mp4";
    try {
      let probe = await fetch(url, { method: "HEAD" });
      if (!probe.ok || !probe.headers.get("content-length")) {
        probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
      }
      sizeBytes = Number(
        probe.headers.get("content-range")?.split("/")[1] ||
          probe.headers.get("content-length") ||
          0,
      );
      mimeType = probe.headers.get("content-type") || mimeType;
    } catch {
      // best-effort; continue with unknown size
    }

    const fee = quoteFee(Math.max(sizeBytes, 1), data.months);
    const paymentTx = mockPaymentTx(data.wallet, fee);
    const stamp = await stampCid(data.cid, data.wallet);

    // Best-effort: pin into our own Pinata account so streaming is reliable.
    await pinByCid(data.cid, data.title);

    const expires = new Date();
    expires.setMonth(expires.getMonth() + data.months);

    const { error: vErr } = await supabaseAdmin.from("videos").insert({
      cid: data.cid,
      owner_wallet: data.wallet,
      title: data.title,
      description: data.description || null,
      size_bytes: sizeBytes,
      mime_type: mimeType,
      status: "mempool",
      tx_hash: stamp.txid,
      op_return_payload: stamp.payload,
      months_prepaid: data.months,
      expires_at: expires.toISOString(),
    });
    if (vErr) {
      if (vErr.code === "23505") await assertCidUnclaimed(data.cid);
      throw new Error(`Failed to save video: ${vErr.message}`);
    }

    const { error: pErr } = await supabaseAdmin.from("payments").insert({
      video_cid: data.cid,
      wallet: data.wallet,
      txc_amount: fee,
      months_prepaid: data.months,
      mock_tx_hash: paymentTx,
    });
    if (pErr) throw new Error(`Failed to save payment: ${pErr.message}`);

    return {
      cid: data.cid,
      sizeBytes,
      mimeType,
      txHash: stamp.txid,
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
      .in("status", ["active", "mempool"])
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

// --- TXC tx confirmation polling ------------------------------------------

/**
 * Look up a video's on-chain status. If still in mempool, queries
 * mempool.texitcoin.org and persists confirmation when it lands. Called from
 * the watch page on a 15s interval until confirmed.
 */
export const pollTxStatus = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ cid: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select("cid, status, tx_hash, block_number, block_hash, created_at")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!video) return null;

    // Already confirmed → just return current state.
    if (video.status === "active" && video.block_number) {
      return {
        status: video.status,
        txHash: video.tx_hash,
        blockNumber: video.block_number,
        blockHash: video.block_hash,
      };
    }

    if (!video.tx_hash) {
      return {
        status: video.status,
        txHash: null,
        blockNumber: null,
        blockHash: null,
      };
    }

    const status = await getTxStatus(video.tx_hash, video.created_at);
    if (status.confirmed && status.blockHeight !== null) {
      await supabaseAdmin
        .from("videos")
        .update({
          status: "active",
          block_number: status.blockHeight,
          block_hash: status.blockHash,
        })
        .eq("cid", data.cid);
      return {
        status: "active",
        txHash: video.tx_hash,
        blockNumber: status.blockHeight,
        blockHash: status.blockHash,
      };
    }

    return {
      status: video.status,
      txHash: video.tx_hash,
      blockNumber: null,
      blockHash: null,
    };
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