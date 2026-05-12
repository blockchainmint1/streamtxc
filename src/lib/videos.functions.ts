import { createServerFn } from "@tanstack/react-start";
import { getRequestIP, getRequestHeader } from "@tanstack/react-start/server";
import { createHash } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  pinFileToIPFS,
  createPresignedUploadUrl,
  pinByCid,
} from "./pinata.server";
import { mockPaymentTx } from "./chain";
import { getTxStatus, explorerTxUrl } from "./txc.server";
import { assignVideoWallet } from "./txc-wallets.server";
import { recordChainEvent, recordMetadataAnchor } from "./chain-events.server";
import { quoteUsd, usdToTxc, MAX_UPLOAD_BYTES } from "./fees";
import { getTxcUsdPrice } from "./txc-price.server";

const walletSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address");

const cidStringSchema = z
  .string()
  .trim()
  .regex(
    /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{50,})$/,
    "Invalid CID",
  );

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
    const price = await getTxcUsdPrice();
    const usd = quoteUsd(data.sizeBytes, data.months);
    return {
      usdAmount: usd,
      txcAmount: usdToTxc(usd, price.usd),
      txcUsd: price.usd,
      priceSource: price.source,
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
        thumbnailCid: cidStringSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await assertCidUnclaimed(data.cid);
    const _price = (await getTxcUsdPrice()).usd;
    const fee = usdToTxc(quoteUsd(data.sizeBytes, data.months), _price);
    const paymentTx = mockPaymentTx(data.wallet, fee);
    const videoWallet = await assignVideoWallet();
    const stamp = await recordChainEvent({
      cid: data.cid,
      videoWallet: videoWallet.address,
      eventType: "C",
      uploaderWallet: data.wallet,
    });
    const videoStatus = stamp.real ? "mempool" : "stamp_failed";
    const txHash = stamp.real ? stamp.txid : null;

    // Anchor title/description on IPFS + chain ("T" stamp). Best-effort —
    // a failure here doesn't block the upload, the row just lacks metadata_cid.
    const meta = await recordMetadataAnchor({
      videoCid: data.cid,
      videoWallet: videoWallet.address,
      uploaderWallet: data.wallet,
      title: data.title,
      description: data.description ?? "",
      thumbnailCid: data.thumbnailCid ?? null,
    });

    const expires = new Date();
    expires.setMonth(expires.getMonth() + data.months);

    const { error: vErr } = await supabaseAdmin.from("videos").insert({
      cid: data.cid,
      owner_wallet: data.wallet,
      title: data.title,
      description: data.description || null,
      size_bytes: data.sizeBytes,
      mime_type: data.mimeType,
      status: videoStatus,
      tx_hash: txHash,
      op_return_payload: stamp.payload,
      months_prepaid: data.months,
      expires_at: expires.toISOString(),
      video_wallet: videoWallet.address,
      derivation_index: videoWallet.derivationIndex,
      payment_required_txc: fee,
      metadata_cid: meta?.metaCid ?? null,
      thumbnail_cid: data.thumbnailCid ?? null,
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
      txHash,
      explorerUrl: txHash ? explorerTxUrl(txHash) : null,
      chainStatus: videoStatus,
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
        thumbnailCid: cidStringSchema.optional(),
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
    const _price = (await getTxcUsdPrice()).usd;
    const fee = usdToTxc(quoteUsd(binary.byteLength, data.months), _price);
    const paymentTx = mockPaymentTx(data.wallet, fee);
    const videoWallet = await assignVideoWallet();
    const stamp = await recordChainEvent({
      cid: pin.cid,
      videoWallet: videoWallet.address,
      eventType: "C",
      uploaderWallet: data.wallet,
    });
    const videoStatus = stamp.real ? "mempool" : "stamp_failed";
    const txHash = stamp.real ? stamp.txid : null;

    const meta = await recordMetadataAnchor({
      videoCid: pin.cid,
      videoWallet: videoWallet.address,
      uploaderWallet: data.wallet,
      title: data.title,
      description: data.description ?? "",
      thumbnailCid: data.thumbnailCid ?? null,
    });

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
        status: videoStatus,
        tx_hash: txHash,
        op_return_payload: stamp.payload,
        months_prepaid: data.months,
        expires_at: expires.toISOString(),
        video_wallet: videoWallet.address,
        derivation_index: videoWallet.derivationIndex,
        payment_required_txc: fee,
        metadata_cid: meta?.metaCid ?? null,
        thumbnail_cid: data.thumbnailCid ?? null,
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
      txHash,
      explorerUrl: txHash ? explorerTxUrl(txHash) : null,
      chainStatus: videoStatus,
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
        thumbnailCid: cidStringSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // Reject if already registered (with structured details for the UI)
    await assertCidUnclaimed(data.cid);

    // 1) Kick off Pinata's "fetch this CID from the IPFS network" job FIRST.
    //    Without this, the gateway HEAD probe below has nothing to serve and
    //    will hang waiting for IPFS DHT discovery to finish.
    await pinByCid(data.cid, data.title);

    // 2) Probe the gateway to learn size + mime, with a generous timeout.
    //    IPFS DHT lookups for fresh CIDs can take 20-30s on a cold gateway.
    const gatewayDomain = process.env.PINATA_GATEWAY_DOMAIN;
    const url = gatewayDomain
      ? `https://${gatewayDomain}/ipfs/${data.cid}`
      : `https://gateway.pinata.cloud/ipfs/${data.cid}`;

    let sizeBytes = 0;
    let mimeType = "video/mp4";
    let probeError: string | null = null;
    const probe = async (init: RequestInit): Promise<Response> => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30_000);
      try {
        return await fetch(url, { ...init, signal: ctl.signal });
      } finally {
        clearTimeout(t);
      }
    };
    try {
      let res = await probe({ method: "HEAD" });
      if (!res.ok || !res.headers.get("content-length")) {
        res = await probe({ headers: { Range: "bytes=0-0" } });
      }
      if (!res.ok) {
        probeError = `Gateway returned ${res.status}`;
      } else {
        sizeBytes = Number(
          res.headers.get("content-range")?.split("/")[1] ||
            res.headers.get("content-length") ||
            0,
        );
        mimeType = res.headers.get("content-type") || mimeType;
      }
    } catch (err) {
      probeError =
        err instanceof Error && err.name === "AbortError"
          ? "Timed out fetching CID from IPFS (30s). The file may not be available on the public IPFS network."
          : err instanceof Error
            ? err.message
            : "Gateway probe failed";
    }

    // Hard fail if we got nothing back OR if the gateway responded but the
    // size is still unknown — better a clear error than a video row with
    // size=0 (which would skip the real hosting fee).
    if (sizeBytes <= 0) {
      throw new Error(
        `CID_NOT_FOUND:${
          probeError ??
          "Gateway returned no content-length yet. The CID is being pinned — try again in 30-60s."
        }`,
      );
    }

    const _price = (await getTxcUsdPrice()).usd;
    const fee = usdToTxc(quoteUsd(Math.max(sizeBytes, 1), data.months), _price);
    const paymentTx = mockPaymentTx(data.wallet, fee);
    const videoWallet = await assignVideoWallet();
    const stamp = await recordChainEvent({
      cid: data.cid,
      videoWallet: videoWallet.address,
      eventType: "C",
      uploaderWallet: data.wallet,
    });
    const videoStatus = stamp.real ? "mempool" : "stamp_failed";
    const txHash = stamp.real ? stamp.txid : null;

    const meta = await recordMetadataAnchor({
      videoCid: data.cid,
      videoWallet: videoWallet.address,
      uploaderWallet: data.wallet,
      title: data.title,
      description: data.description ?? "",
      thumbnailCid: data.thumbnailCid ?? null,
    });

    const expires = new Date();
    expires.setMonth(expires.getMonth() + data.months);

    const { error: vErr } = await supabaseAdmin.from("videos").insert({
      cid: data.cid,
      owner_wallet: data.wallet,
      title: data.title,
      description: data.description || null,
      size_bytes: sizeBytes,
      mime_type: mimeType,
      status: videoStatus,
      tx_hash: txHash,
      op_return_payload: stamp.payload,
      months_prepaid: data.months,
      expires_at: expires.toISOString(),
      video_wallet: videoWallet.address,
      derivation_index: videoWallet.derivationIndex,
      payment_required_txc: fee,
      metadata_cid: meta?.metaCid ?? null,
      thumbnail_cid: data.thumbnailCid ?? null,
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
      txHash,
      chainStatus: videoStatus,
    };
  });

// --- Listings --------------------------------------------------------------

export const listRecentVideos = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        sort: z
          .enum(["newest", "expensive", "comments", "leaving-soon", "most-viewed"])
          .default("newest"),
        limit: z.number().int().min(1).max(48).default(9),
        offset: z.number().int().min(0).default(0),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { sort, limit, offset } = data;
    let query = supabaseAdmin
      .from("videos")
      .select(
        "cid, title, owner_wallet, size_bytes, view_count, created_at, status, payment_required_txc, expires_at, thumbnail_cid",
        { count: "exact" },
      )
      .in("status", ["active", "mempool"])
      .is("hidden_at", null);

    if (sort === "expensive") {
      query = query.order("payment_required_txc", {
        ascending: false,
        nullsFirst: false,
      });
    } else if (sort === "leaving-soon") {
      query = query.order("expires_at", { ascending: true });
    } else if (sort === "most-viewed") {
      query = query.order("view_count", { ascending: false, nullsFirst: false });
    } else {
      // newest + comments both start from newest; we re-sort comments below
      query = query.order("created_at", { ascending: false });
    }

    // For comment sort we need to rank by comment count across the whole
    // active set, so fetch counts first and sort cids before paginating.
    if (sort === "comments") {
      const { data: allRows } = await supabaseAdmin
        .from("videos")
        .select("cid")
        .in("status", ["active", "mempool"])
        .is("hidden_at", null);
      const cids = (allRows ?? []).map((r) => r.cid);
      const { data: cmts } = await supabaseAdmin
        .from("comments")
        .select("video_cid")
        .eq("status", "active")
        .is("hidden_at", null)
        .in("video_cid", cids);
      const counts = new Map<string, number>();
      for (const c of cmts ?? []) {
        counts.set(c.video_cid, (counts.get(c.video_cid) ?? 0) + 1);
      }
      const sortedCids = cids
        .slice()
        .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
      const pageCids = sortedCids.slice(offset, offset + limit);
      const { data: rows, error } = await supabaseAdmin
        .from("videos")
        .select(
          "cid, title, owner_wallet, size_bytes, view_count, created_at, status, payment_required_txc, expires_at, thumbnail_cid",
        )
        .in("cid", pageCids);
      if (error) throw new Error(error.message);
      const ordered = pageCids
        .map((cid) => rows?.find((r) => r.cid === cid))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => ({ ...r, comment_count: counts.get(r.cid) ?? 0 }));
      return { items: ordered, total: cids.length };
    }

    const { data: rows, error, count } = await query.range(
      offset,
      offset + limit - 1,
    );
    if (error) throw new Error(error.message);
    return {
      items: (rows ?? []).map((r) => ({ ...r, comment_count: 0 })),
      total: count ?? rows?.length ?? 0,
    };
  });

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

/**
 * Backfill metadata anchors for older videos that pre-date the "T" stamp.
 * Idempotent — only touches rows where metadata_cid is null. Pass a `cids`
 * array to limit scope (useful for one-off targeted backfills); leave
 * empty for "all".
 */
export const backfillMetadataAnchors = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        cids: z.array(z.string().min(1).max(120)).max(50).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("videos")
      .select("cid, video_wallet, owner_wallet, title, description")
      .is("metadata_cid", null)
      .not("video_wallet", "is", null)
      .order("created_at", { ascending: true })
      .limit(data.limit);
    if (data.cids && data.cids.length > 0) q = q.in("cid", data.cids);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const results: Array<{
      cid: string;
      metaCid: string | null;
      txid: string | null;
      ok: boolean;
      error?: string;
    }> = [];

    for (const v of rows ?? []) {
      try {
        const meta = await recordMetadataAnchor({
          videoCid: v.cid,
          videoWallet: v.video_wallet!,
          uploaderWallet: v.owner_wallet,
          title: v.title,
          description: v.description ?? "",
        });
        if (!meta) {
          results.push({ cid: v.cid, metaCid: null, txid: null, ok: false, error: "pin failed" });
          continue;
        }
        await supabaseAdmin
          .from("videos")
          .update({ metadata_cid: meta.metaCid })
          .eq("cid", v.cid);
        results.push({
          cid: v.cid,
          metaCid: meta.metaCid,
          txid: meta.stamp.real ? meta.stamp.txid : null,
          ok: meta.stamp.real,
        });
      } catch (err) {
        results.push({
          cid: v.cid,
          metaCid: null,
          txid: null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { processed: results.length, results };
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

// --- Content reports / takedowns -----------------------------------------

const REPORT_REASONS = [
  "nsfw",
  "csam",
  "violence",
  "copyright",
  "illegal",
  "spam",
  "other",
] as const;

function hashReporter(): string {
  // Stable per-IP hash (with daily salt) so the same person can't spam reports
  // on the same video, but their identity is never stored in plaintext.
  const ip =
    getRequestIP({ xForwardedFor: true }) ||
    getRequestHeader("x-real-ip") ||
    "unknown";
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${ip}|${day}`).digest("hex");
}

export const reportVideo = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        cid: z.string().min(1).max(200),
        reason: z.enum(REPORT_REASONS),
        details: z.string().max(2000).optional().default(""),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    // Make sure the video exists.
    const { data: video, error: vErr } = await supabaseAdmin
      .from("videos")
      .select("cid, hidden_at, report_count")
      .eq("cid", data.cid)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!video) throw new Error("Video not found");

    const ipHash = hashReporter();

    // Insert report; unique(cid, ip_hash) silently dedupes repeat reports
    // from the same IP on the same day.
    const { error: rErr } = await supabaseAdmin.from("video_reports").insert({
      video_cid: data.cid,
      reason: data.reason,
      details: data.details || null,
      reporter_ip_hash: ipHash,
    });
    if (rErr && rErr.code !== "23505") {
      throw new Error(`Failed to file report: ${rErr.message}`);
    }
    const alreadyReported = rErr?.code === "23505";

    // Recompute count from the source of truth and hide on first report.
    const { count } = await supabaseAdmin
      .from("video_reports")
      .select("id", { count: "exact", head: true })
      .eq("video_cid", data.cid);

    const shouldHide = !video.hidden_at && (count ?? 0) > 0;
    await supabaseAdmin
      .from("videos")
      .update({
        report_count: count ?? 0,
        ...(shouldHide
          ? {
              hidden_at: new Date().toISOString(),
              hidden_reason: `auto-hidden after report (${data.reason})`,
            }
          : {}),
      })
      .eq("cid", data.cid);

    return { ok: true, alreadyReported, reportCount: count ?? 0 };
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
      // Mirror confirmation onto the corresponding chain_events row.
      await supabaseAdmin
        .from("chain_events")
        .update({
          status: "confirmed",
          block_number: status.blockHeight,
          block_hash: status.blockHash,
        })
        .eq("tx_hash", video.tx_hash);
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

// --- Thumbnail pinning + metadata editing --------------------------------

/**
 * Pin a small image (typically a JPEG frame the browser captured from the
 * uploaded video) to IPFS and return the CID. The browser sends the bytes
 * as base64 to keep the server fn payload simple — these are ~50–150 KB.
 */
export const pinThumbnail = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        // base64-encoded image bytes (no data: prefix)
        imageBase64: z.string().min(1).max(2_000_000),
        mimeType: z
          .string()
          .regex(/^image\/(jpeg|png|webp)$/, "Only JPEG/PNG/WebP")
          .default("image/jpeg"),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const bytes = Uint8Array.from(atob(data.imageBase64), (c) =>
      c.charCodeAt(0),
    );
    if (bytes.byteLength > 1_500_000) {
      throw new Error("Thumbnail too large (max 1.5 MB)");
    }
    const ext = data.mimeType.split("/")[1] || "jpg";
    const blob = new Blob([bytes as BlobPart], { type: data.mimeType });
    const pin = await pinFileToIPFS(blob, `thumb.${ext}`);
    return { cid: pin.cid, size: pin.size };
  });

/**
 * Owner-only edit of title / description / thumbnail. Re-pins a fresh
 * metadata JSON to IPFS and stamps a new "T" event on TXC, so the chain
 * keeps a full version history (every edit is its own confirmed tx). The
 * `videos` row is updated to point at the latest metadata_cid for fast
 * read paths.
 */
export const editVideoMetadata = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        cid: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        thumbnailCid: cidStringSchema.nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select("cid, owner_wallet, video_wallet, thumbnail_cid")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!video) throw new Error("Video not found");
    if (video.owner_wallet.toLowerCase() !== data.wallet.toLowerCase()) {
      throw new Error("Only the owner can edit this video");
    }
    if (!video.video_wallet) {
      throw new Error("Video has no on-chain wallet — re-stamp first");
    }

    // null in input means "keep existing", explicit string means "replace",
    // empty string means "remove" (we coerce to null upstream if needed).
    const nextThumb =
      data.thumbnailCid === undefined ? video.thumbnail_cid : data.thumbnailCid;

    const meta = await recordMetadataAnchor({
      videoCid: video.cid,
      videoWallet: video.video_wallet,
      uploaderWallet: video.owner_wallet,
      title: data.title,
      description: data.description ?? "",
      thumbnailCid: nextThumb,
    });

    const { error: uErr } = await supabaseAdmin
      .from("videos")
      .update({
        title: data.title,
        description: data.description || null,
        thumbnail_cid: nextThumb,
        metadata_cid: meta?.metaCid ?? null,
      })
      .eq("cid", video.cid);
    if (uErr) throw new Error(`Failed to update video: ${uErr.message}`);

    return {
      cid: video.cid,
      metaCid: meta?.metaCid ?? null,
      txid: meta?.stamp.real ? meta.stamp.txid : null,
      stamped: !!meta?.stamp.real,
    };
  });