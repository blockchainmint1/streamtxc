import { createServerFn } from "@tanstack/react-start";
import { getRequestIP, getRequestHeader } from "@tanstack/react-start/server";
import { createHash } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireWalletSession } from "./wallet-auth.functions";
import {
  pinFileToIPFS,
  createPresignedUploadUrl,
  pinByCid,
  headCidOnGateway,
} from "./pinata.server";
import { mockPaymentTx } from "./chain";
import { getTxStatus, explorerTxUrl } from "./txc.server";
import { assignVideoWallet } from "./txc-wallets.server";
import { recordChainEvent, recordMetadataAnchor } from "./chain-events.server";
import { recordOwnershipAnchor, recordSplitPayout } from "./chain-events.server";
import { verifyMessage, sendToAddress, getPlatformAddress } from "./txc.server";
import { retryStuckStampForVideo } from "./stamp-retry.server";
import { quoteUsd, usdToTxc, MAX_UPLOAD_BYTES, MAX_S3_UPLOAD_BYTES, PAYMENT_GRACE_HOURS } from "./fees";
import { getTxcUsdPrice } from "./txc-price.server";

// Accepts either an EVM-style 0x… (legacy mock-wallet rows) or a real TXC
// base58 address (LTC clone — starts with L/M/T/3 etc. or bech32 txc1…).
// Kept permissive so existing 0x rows in the DB keep working while the new
// TXC flow is rolled out.
const walletSchema = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(
    /^(0x[a-fA-F0-9]{40}|[a-zA-Z0-9]{20,90})$/,
    "Invalid wallet address",
  );

/** Same as walletSchema but optional — used at upload time. */
const optionalWalletSchema = walletSchema.optional().nullable();

/** Owner-comparison helper that tolerates null/legacy-case mismatches. */
function ownerMatches(rowOwner: string | null, claim: string): boolean {
  if (!rowOwner) return false;
  return rowOwner.toLowerCase() === claim.toLowerCase();
}

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
        wallet: optionalWalletSchema,
        cid: z
          .string()
          .trim()
          .regex(
            /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{50,})$/,
            "Invalid CID",
          ),
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        sizeBytes: z.number().int().positive().max(MAX_S3_UPLOAD_BYTES),
        mimeType: z.string().min(1).max(100),
        months: z.number().int().min(1).max(12).default(1),
        thumbnailCid: cidStringSchema.optional(),
        nsfw: z.boolean().optional().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    await assertCidUnclaimed(data.cid);
    const _price = (await getTxcUsdPrice()).usd;
    const fee = usdToTxc(quoteUsd(data.sizeBytes, data.months), _price);
    const ownerWallet = data.wallet ?? null;
    const opReturnWallet = ownerWallet ?? "anon";
    const paymentTx = mockPaymentTx(opReturnWallet, fee);
    const videoWallet = await assignVideoWallet();
    const stamp = await recordChainEvent({
      cid: data.cid,
      videoWallet: videoWallet.address,
      eventType: "C",
      uploaderWallet: opReturnWallet,
    });
    const videoStatus = stamp.real ? "mempool" : "stamp_failed";
    const txHash = stamp.real ? stamp.txid : null;

    // Anchor title/description on IPFS + chain ("T" stamp). Best-effort —
    // a failure here doesn't block the upload, the row just lacks metadata_cid.
    const meta = await recordMetadataAnchor({
      videoCid: data.cid,
      videoWallet: videoWallet.address,
      uploaderWallet: opReturnWallet,
      title: data.title,
      description: data.description ?? "",
      thumbnailCid: data.thumbnailCid ?? null,
    });

    // New uploads get a 7-day free grace window. Payment extends from created_at
    // by `monthsCredited * 30 days` (handled by the payment watcher).
    const expires = new Date(Date.now() + PAYMENT_GRACE_HOURS * 3_600_000);

    const { error: vErr } = await supabaseAdmin.from("videos").insert({
      cid: data.cid,
      owner_wallet: ownerWallet,
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
      is_nsfw: data.nsfw,
    });
    if (vErr) {
      // Race condition: someone registered the same CID between our check
      // and the insert. Re-run the duplicate check to surface a friendly error.
      if (vErr.code === "23505") await assertCidUnclaimed(data.cid);
      throw new Error(`Failed to save video: ${vErr.message}`);
    }

    if (ownerWallet) {
      const { error: pErr } = await supabaseAdmin.from("payments").insert({
        video_cid: data.cid,
        wallet: ownerWallet,
        txc_amount: fee,
        months_prepaid: data.months,
        mock_tx_hash: paymentTx,
      });
      if (pErr) throw new Error(`Failed to save payment: ${pErr.message}`);
    }

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
        wallet: optionalWalletSchema,
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        months: z.number().int().min(1).max(12).default(1),
        // Base64-encoded file (for MVP < 100MB).
        fileBase64: z.string().min(1),
        filename: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(100),
        thumbnailCid: cidStringSchema.optional(),
        nsfw: z.boolean().optional().default(false),
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
    const ownerWallet = data.wallet ?? null;
    const opReturnWallet = ownerWallet ?? "anon";
    const paymentTx = mockPaymentTx(opReturnWallet, fee);
    const videoWallet = await assignVideoWallet();
    const stamp = await recordChainEvent({
      cid: pin.cid,
      videoWallet: videoWallet.address,
      eventType: "C",
      uploaderWallet: opReturnWallet,
    });
    const videoStatus = stamp.real ? "mempool" : "stamp_failed";
    const txHash = stamp.real ? stamp.txid : null;

    const meta = await recordMetadataAnchor({
      videoCid: pin.cid,
      videoWallet: videoWallet.address,
      uploaderWallet: opReturnWallet,
      title: data.title,
      description: data.description ?? "",
      thumbnailCid: data.thumbnailCid ?? null,
    });

    // 3. Persist — 7-day free grace; payment extends from created_at.
    const expires = new Date(Date.now() + PAYMENT_GRACE_HOURS * 3_600_000);

    const { error: vErr } = await supabaseAdmin
      .from("videos")
      .insert({
        cid: pin.cid,
        owner_wallet: ownerWallet,
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
        is_nsfw: data.nsfw,
      });
    if (vErr) {
      if (vErr.code === "23505") await assertCidUnclaimed(pin.cid);
      throw new Error(`Failed to save video: ${vErr.message}`);
    }

    if (ownerWallet) {
      const { error: pErr } = await supabaseAdmin.from("payments").insert({
        video_cid: pin.cid,
        wallet: ownerWallet,
        txc_amount: fee,
        months_prepaid: data.months,
        mock_tx_hash: paymentTx,
      });
      if (pErr) throw new Error(`Failed to save payment: ${pErr.message}`);
    }

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

/**
 * Look up whether either form (CIDv1 or CIDv0) of a file is already pinned
 * in OUR Pinata account. Used by the upload flow to skip re-uploading bytes
 * we already host. We deliberately don't probe the public IPFS network — a
 * gateway hit doesn't mean Pinata has it, and a missing pin would hang the
 * downstream addByCid probe for 30s.
 */
export const lookupPinnedCid = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({ cidV1: cidStringSchema, cidV0: cidStringSchema })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) return null;
    const probe = async (cid: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `https://api.pinata.cloud/v3/files/public?cid=${encodeURIComponent(cid)}`,
          { headers: { Authorization: `Bearer ${jwt}` } },
        );
        if (!res.ok) return false;
        const json = (await res.json()) as {
          data?: { files?: { id: string }[] };
        };
        return (json.data?.files?.length ?? 0) > 0;
      } catch {
        return false;
      }
    };
    const [v1, v0] = await Promise.all([probe(data.cidV1), probe(data.cidV0)]);
    if (v1) return { cid: data.cidV1, version: 1 as const };
    if (v0) return { cid: data.cidV0, version: 0 as const };
    return null;
  });

export const addByCid = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        wallet: optionalWalletSchema,
        cid: cidSchema,
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional().default(""),
        months: z.number().int().min(1).max(12).default(1),
        thumbnailCid: cidStringSchema.optional(),
        nsfw: z.boolean().optional().default(false),
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
    const ownerWallet = data.wallet ?? null;
    const opReturnWallet = ownerWallet ?? "anon";
    const paymentTx = mockPaymentTx(opReturnWallet, fee);
    const videoWallet = await assignVideoWallet();
    const stamp = await recordChainEvent({
      cid: data.cid,
      videoWallet: videoWallet.address,
      eventType: "C",
      uploaderWallet: opReturnWallet,
    });
    const videoStatus = stamp.real ? "mempool" : "stamp_failed";
    const txHash = stamp.real ? stamp.txid : null;

    const meta = await recordMetadataAnchor({
      videoCid: data.cid,
      videoWallet: videoWallet.address,
      uploaderWallet: opReturnWallet,
      title: data.title,
      description: data.description ?? "",
      thumbnailCid: data.thumbnailCid ?? null,
    });

    // 7-day free grace; payment extends from created_at.
    const expires = new Date(Date.now() + PAYMENT_GRACE_HOURS * 3_600_000);

    const { error: vErr } = await supabaseAdmin.from("videos").insert({
      cid: data.cid,
      owner_wallet: ownerWallet,
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
      is_nsfw: data.nsfw,
    });
    if (vErr) {
      if (vErr.code === "23505") await assertCidUnclaimed(data.cid);
      throw new Error(`Failed to save video: ${vErr.message}`);
    }

    if (ownerWallet) {
      const { error: pErr } = await supabaseAdmin.from("payments").insert({
        video_cid: data.cid,
        wallet: ownerWallet,
        txc_amount: fee,
        months_prepaid: data.months,
        mock_tx_hash: paymentTx,
      });
      if (pErr) throw new Error(`Failed to save payment: ${pErr.message}`);
    }

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
      .is("hidden_at", null)
      .eq("is_nsfw", false);

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
        .is("hidden_at", null)
        .eq("is_nsfw", false);
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
          uploaderWallet: v.owner_wallet ?? "anon",
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
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z.object({ wallet: walletSchema }).parse(input),
  )
  .handler(async ({ context }) => {
    const wallet = context.wallet;
    const { data: videos, error } = await supabaseAdmin
      .from("videos")
      .select("*")
      .eq("owner_wallet", wallet)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return videos ?? [];
  });

/**
 * Public listing of videos uploaded by a specific wallet. Used by the
 * /u/$wallet "channel" page. Returns the same shape as listRecentVideos
 * so the same card grid can render the results.
 */
export const listVideosByOwner = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ wallet: walletSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("videos")
      .select(
        "cid, title, owner_wallet, size_bytes, view_count, created_at, status, payment_required_txc, payment_received_txc, expires_at, thumbnail_cid, video_wallet, unpinned_at",
      )
      .eq("owner_wallet", data.wallet)
      .in("status", ["active", "mempool", "unpinned"])
      .is("hidden_at", null)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { items: (rows ?? []).map((r) => ({ ...r, comment_count: 0 })) };
  });

/**
 * Best-effort: ask Pinata to re-pin every `unpinned` CID owned by `wallet`
 * by fetching it from the public IPFS DHT. Pinata returns success even if
 * the content isn't yet found — the actual fetch happens asynchronously.
 * We don't flip the row back to `active` here; the payment-watcher does
 * that once a renewal payment lands.
 */
export const restoreUnpinnedVideos = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ wallet: walletSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("videos")
      .select("cid, title")
      .eq("owner_wallet", data.wallet)
      .eq("status", "unpinned")
      .limit(100);
    if (error) throw new Error(error.message);
    const items = rows ?? [];
    let queued = 0;
    let failed = 0;
    for (const v of items) {
      try {
        await pinByCid(v.cid, v.title ?? v.cid);
        queued += 1;
      } catch (err) {
        console.warn("restoreUnpinnedVideos pinByCid failed", v.cid, err);
        failed += 1;
      }
    }
    return { total: items.length, queued, failed };
  });

/**
 * Live availability probe for a single CID. Used by the watch page to
 * decide whether to render the player or the "no longer on IPFS" overlay.
 * Treats a row as unavailable if EITHER `unpinned_at` is set OR the
 * gateway HEAD probe fails — the two get out of sync (e.g. the
 * Restore-from-IPFS flow queues a pin but doesn't verify the bytes
 * actually came back), so we trust the live probe over `status`.
 */
export const probeAvailability = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ cid: cidStringSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: row } = await supabaseAdmin
      .from("videos")
      .select("cid, unpinned_at")
      .eq("cid", data.cid)
      .maybeSingle();
    const unpinnedFlag = !!row?.unpinned_at;
    // Trust the DB. The payment-watcher only sets `unpinned_at` after it
    // actually unpins from Pinata, and only clears it after re-pinning AND
    // verifying the gateway can serve the bytes again. A live HEAD probe
    // here was producing false negatives (Worker→dedicated-gateway HEAD
    // requests occasionally fail / time out even when the bytes are fine),
    // which painted the "no longer on IPFS" overlay over healthy videos.
    // If a CID does go missing, the watcher flips `unpinned_at` on the
    // next tick and the overlay appears then.
    const reachable = !unpinnedFlag;
    return {
      cid: data.cid,
      reachable,
      unpinnedFlag,
      available: !unpinnedFlag,
      checkedAt: new Date().toISOString(),
    };
  });

/**
 * Public single-CID restore. Asks Pinata to re-fetch this CID from the
 * IPFS DHT. Best-effort — Pinata may say "queued" even if no peer is
 * actually seeding it. Status is not flipped here; the watch page's
 * probeAvailability call decides truth from the live gateway HEAD.
 */
export const restoreOneFromIpfs = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ cid: cidStringSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: row } = await supabaseAdmin
      .from("videos")
      .select("cid, title")
      .eq("cid", data.cid)
      .maybeSingle();
    if (!row) throw new Error("Video not found.");
    try {
      await pinByCid(row.cid, row.title ?? row.cid);
      return { ok: true };
    } catch (err) {
      console.warn("restoreOneFromIpfs failed", row.cid, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

/**
 * Owner-only re-seed. Called after the browser has re-uploaded the
 * original file via /api/public/upload — that endpoint already pinned
 * the bytes to our Pinata account, so by the time we get here the CID
 * is back on the gateway. We just verify, clear `unpinned_at`, flip
 * status to `active`, and stamp an `R` (renewal/re-seed) event.
 */
export const reseedVideo = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z.object({ cid: cidStringSchema }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const callerWallet = context.wallet;
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select(
        "cid, owner_wallet, video_wallet, expires_at, unpinned_at, status",
      )
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!video) throw new Error("Video not found.");
    if (!ownerMatches(video.owner_wallet, callerWallet)) {
      throw new Error(
        "Only the original uploader's wallet can re-seed this video.",
      );
    }

    // The browser already POSTed the file through /api/public/upload,
    // which pins it to our Pinata account. Confirm the gateway now
    // serves the CID before we flip any DB state.
    const reachable = await headCidOnGateway(data.cid, 8000);
    if (!reachable) {
      throw new Error(
        "Re-seed pinned, but the gateway can't serve the file yet. Wait a minute and try again.",
      );
    }

    await supabaseAdmin
      .from("videos")
      .update({
        unpinned_at: null,
        status: "active",
        expiring_at: null,
        unpin_after: null,
        notified_pre_expiry_at: null,
        notified_expiring_at: null,
        notified_unpinned_at: null,
      })
      .eq("cid", data.cid);

    // Best-effort chain stamp. Don't fail the re-seed if the broadcast
    // hiccups — recordChainEvent already stubs a placeholder txid in
    // that case.
    let stampTxid: string | null = null;
    try {
      if (video.video_wallet) {
        const stamp = await recordChainEvent({
          cid: video.cid,
          videoWallet: video.video_wallet,
          eventType: "R",
          uploaderWallet: callerWallet,
          extra: "reseed",
        });
        stampTxid = stamp.real ? stamp.txid : null;
      }
    } catch (err) {
      console.warn("reseedVideo: chain stamp failed", err);
    }

    const expiresAt = video.expires_at
      ? new Date(video.expires_at).getTime()
      : 0;
    const expired = expiresAt > 0 && expiresAt < Date.now();

    return {
      cid: video.cid,
      reachable: true,
      stampTxid,
      expired,
      expiresAt: video.expires_at,
    };
  });

/**
 * Fetch a batch of videos by CID. Used by /manage to surface anonymous
 * uploads tracked in the browser's localStorage so the user can later
 * claim ownership of them.
 */
export const listVideosByCids = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        cids: z.array(cidStringSchema).min(1).max(100),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: videos, error } = await supabaseAdmin
      .from("videos")
      .select("*")
      .in("cid", data.cids)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return videos ?? [];
  });

/**
 * Owner-only show/hide toggle. Hidden videos are filtered out of all public
 * listings (listRecentVideos already does `is hidden_at null`) but remain in
 * the owner's /manage view so they can be unhidden.
 */
export const setVideoVisibility = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        cid: cidStringSchema,
        hidden: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: row, error: rErr } = await supabaseAdmin
      .from("videos")
      .select("cid, owner_wallet")
      .eq("cid", data.cid)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!row) throw new Error("Video not found");
    if (!ownerMatches(row.owner_wallet, wallet)) {
      throw new Error("Not the owner of this video");
    }

    const { error } = await supabaseAdmin
      .from("videos")
      .update({
        hidden_at: data.hidden ? new Date().toISOString() : null,
        hidden_reason: data.hidden ? "owner-hidden" : null,
      })
      .eq("cid", data.cid);
    if (error) throw new Error(error.message);
    return { cid: data.cid, hidden: data.hidden };
  });

/**
 * Owner-side "flagged for follow-up" marker. Doesn't affect public visibility
 * — just shows a badge in /manage so the owner can come back to it.
 */
export const setVideoFlagged = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        cid: cidStringSchema,
        flagged: z.boolean(),
        reason: z.string().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: row, error: rErr } = await supabaseAdmin
      .from("videos")
      .select("cid, owner_wallet")
      .eq("cid", data.cid)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!row) throw new Error("Video not found");
    if (!ownerMatches(row.owner_wallet, wallet)) {
      throw new Error("Not the owner of this video");
    }

    const { error } = await supabaseAdmin
      .from("videos")
      .update({
        flagged_at: data.flagged ? new Date().toISOString() : null,
        flagged_reason: data.flagged ? (data.reason ?? "owner-flagged") : null,
      })
      .eq("cid", data.cid);
    if (error) throw new Error(error.message);
    return { cid: data.cid, flagged: data.flagged };
  });

// --- Bulk extend (sendmany helper) ----------------------------------------

/**
 * Build a copy-pasteable `sendmany` command that extends every video the
 * connected wallet owns by N months. Returns per-video amounts plus the full
 * CLI string. Nothing is broadcast — the user pastes this into their wallet.
 */
export const buildBulkExtendQuote = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        months: z.number().int().min(1).max(12).default(1),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: rows, error } = await supabaseAdmin
      .from("videos")
      .select("cid, title, video_wallet, size_bytes, expires_at")
      .eq("owner_wallet", wallet)
      .not("video_wallet", "is", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const price = await getTxcUsdPrice();
    const items = (rows ?? []).map((v) => {
      const usd = quoteUsd(v.size_bytes, data.months);
      const txcRaw = usdToTxc(usd, price.usd);
      // Round to 8 decimal places (TXC max precision).
      const txcAmount = Math.round(txcRaw * 1e8) / 1e8;
      return {
        cid: v.cid,
        title: v.title,
        depositAddress: v.video_wallet as string,
        usdAmount: usd,
        txcAmount,
      };
    });

    // Collapse duplicate addresses (sendmany requires unique keys).
    const sumByAddr = new Map<string, number>();
    for (const it of items) {
      sumByAddr.set(
        it.depositAddress,
        Math.round(((sumByAddr.get(it.depositAddress) ?? 0) + it.txcAmount) * 1e8) / 1e8,
      );
    }
    const obj: Record<string, number> = {};
    for (const [addr, amt] of sumByAddr.entries()) obj[addr] = amt;

    const totalTxc = Math.round(items.reduce((s, x) => s + x.txcAmount, 0) * 1e8) / 1e8;
    const totalUsd = items.reduce((s, x) => s + x.usdAmount, 0);
    const sendmanyJson = JSON.stringify(obj);
    const sendmanyCli = `texitcoin-cli sendmany "" '${sendmanyJson}'`;

    return {
      months: data.months,
      txcUsd: price.usd,
      priceSource: price.source,
      totalTxc,
      totalUsd,
      items,
      sendmanyJson,
      sendmanyCli,
    };
  });

/**
 * Trust-based "I paid the sendmany" confirmation. Bumps expires_at on every
 * video the user owns by N months and inserts a payments row per video so the
 * audit log matches. Does NOT verify the on-chain TX — pair with the watcher
 * later when extension semantics land there.
 */
export const markBulkExtended = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        months: z.number().int().min(1).max(12).default(1),
        txHash: z.string().trim().max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: rows, error } = await supabaseAdmin
      .from("videos")
      .select("cid, video_wallet, size_bytes, expires_at, months_prepaid")
      .eq("owner_wallet", wallet)
      .not("video_wallet", "is", null);
    if (error) throw new Error(error.message);

    const price = await getTxcUsdPrice();
    const updated: string[] = [];
    for (const v of rows ?? []) {
      const usd = quoteUsd(v.size_bytes, data.months);
      const txcAmount = Math.round(usdToTxc(usd, price.usd) * 1e8) / 1e8;
      const base = new Date(
        Math.max(new Date(v.expires_at).getTime(), Date.now()),
      );
      base.setDate(base.getDate() + data.months * 30);

      const { error: uErr } = await supabaseAdmin
        .from("videos")
        .update({
          expires_at: base.toISOString(),
          months_prepaid: (v.months_prepaid ?? 0) + data.months,
        })
        .eq("cid", v.cid);
      if (uErr) continue;

      await supabaseAdmin.from("payments").insert({
        video_cid: v.cid,
        wallet,
        txc_amount: txcAmount,
        months_prepaid: data.months,
        mock_tx_hash: data.txHash || `bulk-extend-${Date.now()}`,
      });
      updated.push(v.cid);
    }
    return { extended: updated.length, cids: updated };
  });

/**
 * Verify a real on-chain `sendmany` TX and credit each matching video by the
 * exact amount paid to its deposit address. Per-output proration:
 *   days_added = (paidTxc / monthlyFeeTxc) * 30  (floored to whole days)
 * Idempotent: re-pasting the same txid is a no-op (uniqueness on
 * payments.mock_tx_hash + video_cid). Credits ANY matching video_wallet
 * regardless of caller — ownership is not enforced here.
 */
export const verifyBulkExtensionTx = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        txHash: z
          .string()
          .trim()
          .regex(/^[0-9a-fA-F]{64}$/, "Expected a 64-char hex txid"),
        // Mempool is fine — we trust the sender. Set true to require ≥1 conf.
        requireConfirmed: z.boolean().default(false),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";

    // 1. Fetch the tx from the mempool/esplora API.
    let tx: {
      txid: string;
      vin: Array<{ prevout?: { scriptpubkey_address?: string } }>;
      vout: Array<{ scriptpubkey_address?: string; value: number }>;
      status?: {
        confirmed?: boolean;
        block_height?: number;
        block_hash?: string;
      };
    };
    try {
      const res = await fetch(`${base}/api/tx/${data.txHash}`);
      if (res.status === 404) {
        throw new Error("TX not found yet — give the network ~30s and retry.");
      }
      if (!res.ok) {
        throw new Error(`Mempool API returned ${res.status}`);
      }
      tx = await res.json();
    } catch (err) {
      if (err instanceof Error) throw err;
      throw new Error("Failed to fetch tx");
    }

    const confirmed = !!tx.status?.confirmed;
    if (data.requireConfirmed && !confirmed) {
      return {
        pending: true,
        confirmed: false,
        txHash: data.txHash,
        matched: [] as Array<{
          cid: string;
          title: string;
          address: string;
          paidTxc: number;
          monthlyFeeTxc: number;
          daysAdded: number;
          newExpiresAt: string;
        }>,
        unmatched: [] as Array<{ address: string; paidTxc: number }>,
        skippedDust: [] as Array<{
          cid: string;
          address: string;
          paidTxc: number;
        }>,
        alreadyCredited: [] as Array<{ cid: string; address: string }>,
      };
    }

    // 2. Collapse outputs by address (sendmany should already have unique
    //    addresses, but a hand-built tx might have duplicates).
    const paidByAddr = new Map<string, number>();
    for (const o of tx.vout) {
      const addr = o.scriptpubkey_address;
      if (!addr) continue;
      // Esplora returns `value` in satoshis.
      const txc = o.value / 1e8;
      paidByAddr.set(addr, (paidByAddr.get(addr) ?? 0) + txc);
    }

    // 3. Look up videos for these addresses.
    const addresses = Array.from(paidByAddr.keys());
    const { data: vids, error: vErr } = await supabaseAdmin
      .from("videos")
      .select("cid, title, video_wallet, size_bytes, expires_at, months_prepaid")
      .in("video_wallet", addresses);
    if (vErr) throw new Error(vErr.message);

    const matchedAddrs = new Set((vids ?? []).map((v) => v.video_wallet!));
    const price = await getTxcUsdPrice();

    // 4. Idempotency check — find which (txHash, cid) pairs are already
    //    credited from a previous paste.
    const { data: existingPays } = await supabaseAdmin
      .from("payments")
      .select("video_cid")
      .eq("mock_tx_hash", data.txHash);
    const alreadyCreditedCids = new Set(
      (existingPays ?? []).map((p) => p.video_cid),
    );

    const payerWallet =
      tx.vin[0]?.prevout?.scriptpubkey_address ?? "external";

    const matched: Array<{
      cid: string;
      title: string;
      address: string;
      paidTxc: number;
      monthlyFeeTxc: number;
      daysAdded: number;
      newExpiresAt: string;
    }> = [];
    const skippedDust: Array<{ cid: string; address: string; paidTxc: number }> = [];
    const alreadyCredited: Array<{ cid: string; address: string }> = [];

    for (const v of vids ?? []) {
      const addr = v.video_wallet!;
      const paidTxc = paidByAddr.get(addr) ?? 0;
      if (paidTxc <= 0) continue;

      if (alreadyCreditedCids.has(v.cid)) {
        alreadyCredited.push({ cid: v.cid, address: addr });
        continue;
      }

      const monthlyUsd = quoteUsd(v.size_bytes, 1);
      const monthlyFeeTxc = Math.round(usdToTxc(monthlyUsd, price.usd) * 1e8) / 1e8;
      if (monthlyFeeTxc <= 0) {
        skippedDust.push({ cid: v.cid, address: addr, paidTxc });
        continue;
      }

      const monthsPaid = paidTxc / monthlyFeeTxc;
      const daysAdded = Math.floor(monthsPaid * 30);
      if (daysAdded < 1) {
        skippedDust.push({ cid: v.cid, address: addr, paidTxc });
        continue;
      }

      const base = new Date(
        Math.max(new Date(v.expires_at).getTime(), Date.now()),
      );
      base.setDate(base.getDate() + daysAdded);
      const newExpiresAt = base.toISOString();

      const { error: uErr } = await supabaseAdmin
        .from("videos")
        .update({
          expires_at: newExpiresAt,
          months_prepaid: (v.months_prepaid ?? 0) + Math.floor(monthsPaid),
        })
        .eq("cid", v.cid);
      if (uErr) continue;

      await supabaseAdmin.from("payments").insert({
        video_cid: v.cid,
        wallet: payerWallet,
        txc_amount: Math.round(paidTxc * 1e8) / 1e8,
        months_prepaid: Math.floor(monthsPaid),
        mock_tx_hash: data.txHash,
      });

      // Audit trail — "R" (renewal) chain event.
      await supabaseAdmin.from("chain_events").insert({
        video_cid: v.cid,
        video_wallet: addr,
        event_type: "R",
        tx_hash: data.txHash,
        op_return_payload: `sendmany|${paidTxc.toFixed(8)}|${daysAdded}d`,
        from_wallet: payerWallet,
        to_wallet: addr,
        status: confirmed ? "confirmed" : "mempool",
        block_hash: tx.status?.block_hash ?? null,
        block_number: tx.status?.block_height ?? null,
        metadata: {
          source: "bulk-extend",
          paid_txc: paidTxc,
          monthly_fee_txc: monthlyFeeTxc,
          days_added: daysAdded,
        } as never,
      });

      matched.push({
        cid: v.cid,
        title: v.title,
        address: addr,
        paidTxc: Math.round(paidTxc * 1e8) / 1e8,
        monthlyFeeTxc,
        daysAdded,
        newExpiresAt,
      });
    }

    // 5. Outputs that didn't match any video deposit address.
    const unmatched: Array<{ address: string; paidTxc: number }> = [];
    for (const [addr, paidTxc] of paidByAddr.entries()) {
      if (!matchedAddrs.has(addr)) {
        unmatched.push({
          address: addr,
          paidTxc: Math.round(paidTxc * 1e8) / 1e8,
        });
      }
    }

    return {
      pending: false,
      confirmed,
      txHash: data.txHash,
      matched,
      unmatched,
      skippedDust,
      alreadyCredited,
    };
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

/**
 * Owner-triggered retry of the C/T on-chain stamps. Used when an upload
 * landed in `stamp_failed` (e.g. the TXC hot wallet was empty). Verifies
 * the requesting wallet owns the video before broadcasting.
 */
export const retryOwnStamp = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        cid: z.string().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: v, error } = await supabaseAdmin
      .from("videos")
      .select("cid, owner_wallet, status")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!v) throw new Error("Video not found");
    if (!ownerMatches(v.owner_wallet, wallet)) {
      throw new Error("Not your video");
    }
    if (v.status !== "stamp_failed") {
      return { ok: true, alreadyStamped: true, status: v.status };
    }
    const result = await retryStuckStampForVideo(data.cid);
    return { ok: result.cStamp.ok, ...result };
  });

/**
 * Owner-triggered restart of MediaConvert transcoding. Used when a job
 * got lost (worker timeout, webhook miss, etc.) and the video is stuck
 * in `transcode_status='processing'` or `'failed'`. The S3 input object
 * at `inputs/<cid>` is reused, so no re-upload is needed.
 */
export const retryOwnTranscode = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        cid: z.string().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: v, error } = await supabaseAdmin
      .from("videos")
      .select("cid, owner_wallet, transcode_status, hls_cid")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!v) throw new Error("Video not found");
    if (!ownerMatches(v.owner_wallet, wallet)) {
      throw new Error("Not your video");
    }
    if (v.hls_cid) {
      return { ok: true, alreadyTranscoded: true, hlsCid: v.hls_cid };
    }

    const inputBucket = process.env.AWS_S3_INPUT_BUCKET;
    const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
    if (!inputBucket || !outputBucket) {
      throw new Error("Transcode not configured");
    }

    const { startHlsTranscode } = await import("./aws-mediaconvert.server");
    const { jobId } = await startHlsTranscode({
      inputUri: `s3://${inputBucket}/inputs/${data.cid}`,
      outputPrefix: `s3://${outputBucket}/hls/${data.cid}/`,
      videoId: data.cid,
    });

    await supabaseAdmin
      .from("videos")
      .update({
        transcode_status: "processing",
        transcode_job_id: jobId,
        transcode_started_at: new Date().toISOString(),
        transcode_completed_at: null,
        transcode_error: null,
      })
      .eq("cid", data.cid);

    return { ok: true, jobId };
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

  // Reward credit — only if the video has a verified owner wallet to credit.
  if (video.owner_wallet) {
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
  }

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
  .middleware([requireWalletSession])
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
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select("cid, owner_wallet, video_wallet, thumbnail_cid")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!video) throw new Error("Video not found");
    if (!ownerMatches(video.owner_wallet, wallet)) {
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
      uploaderWallet: video.owner_wallet ?? wallet,
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

// --- Ownership proof ------------------------------------------------------

/**
 * Build the canonical ownership-challenge message. The exact format matters —
 * the user signs THIS string in their TXC wallet, so any drift between
 * frontend and verifier breaks the proof.
 */
function buildOwnershipMessage(opts: {
  cid: string;
  wallet: string;
  nonce: string;
}): string {
  // Human-readable, EIP-4361-style challenge so the signer can SEE exactly
  // what they're authorizing. The CID + wallet + nonce are all bound into
  // the message, so a paster can't re-aim a signature at a different video
  // or a different address.
  return [
    "streamTXC — Claim video ownership",
    "",
    "Domain: streamtxc.com",
    `Address: ${opts.wallet}`,
    `Video CID: ${opts.cid}`,
    `Nonce: ${opts.nonce}`,
    "",
    "Signing this message does NOT authorize any transaction or spend any TXC.",
  ].join("\n");
}

const txcWalletSchema = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[a-zA-Z0-9]+$/, "Invalid TXC address");

const signableOwnershipWalletSchema = txcWalletSchema.refine(
  (value) =>
    /^T[1-9A-HJ-NP-Za-km-z]{20,90}$/.test(value) ||
    /^txc1[0-9a-z]{20,90}$/i.test(value),
  "Use a TXC wallet address (legacy T… or bech32 txc1…) for ownership verification.",
);

/**
 * Issue a fresh nonce + return the exact message the user must sign in
 * their TXC web wallet. Re-callable: each call rotates the nonce so an
 * abandoned attempt can't be replayed.
 */
export const getOwnershipChallenge = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        cid: z.string().min(1).max(200),
        ownerWallet: signableOwnershipWalletSchema,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select("cid, owner_wallet, video_wallet, owner_nonce")
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!video) throw new Error("Video not found");

    // Reuse an existing nonce when one is already set so re-opening the
    // dialog (or the wallet-input debounce re-firing) does NOT invalidate
    // a signature the user already pasted. We only mint a new nonce when
    // none exists for this video. The wallet that "owns" the nonce is
    // determined at verify time — the message includes the claimed wallet,
    // so a wallet swap won't accidentally accept the wrong signer.
    let nonce = video.owner_nonce ?? null;
    if (!nonce) {
      nonce = createHash("sha256")
        .update(
          `${data.cid}:${data.ownerWallet}:${Date.now()}:${Math.random()}`,
        )
        .digest("hex")
        .slice(0, 32);
      const { error: uErr } = await supabaseAdmin
        .from("videos")
        .update({ owner_nonce: nonce })
        .eq("cid", data.cid);
      if (uErr) throw new Error(uErr.message);
    }

    const message = buildOwnershipMessage({
      cid: data.cid,
      wallet: data.ownerWallet,
      nonce,
    });
    return { message, nonce, walletToSignWith: data.ownerWallet };
  });

/**
 * Verify a signed challenge. On success: stores the wallet+sig, stamps an
 * "O" anchor on chain, and (best-effort) sweeps any escrowed creator
 * earnings to the now-verified wallet.
 */
export const submitOwnershipProof = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        cid: z.string().min(1).max(200),
        ownerWallet: signableOwnershipWalletSchema,
        signature: z.string().trim().min(8).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: video, error } = await supabaseAdmin
      .from("videos")
      .select(
        "cid, owner_wallet, video_wallet, owner_nonce, escrowed_creator_txc",
      )
      .eq("cid", data.cid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!video) throw new Error("Video not found");
    if (!video.owner_nonce)
      throw new Error("No active challenge — request a new one");

    const message = buildOwnershipMessage({
      cid: video.cid,
      wallet: data.ownerWallet,
      nonce: video.owner_nonce,
    });
    console.log("[submitOwnershipProof] verifying", {
      cid: video.cid,
      ownerWallet: data.ownerWallet,
      nonce: video.owner_nonce,
      sigLen: data.signature.length,
      messagePreview: message.slice(0, 80),
    });
    let ok = false;
    try {
      ok = await verifyMessage(data.ownerWallet, data.signature, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error("[submitOwnershipProof] verifyMessage threw", reason);
      throw new Error(`Could not verify signature: ${reason}`);
    }
    if (!ok) {
      throw new Error(
        "Signature did not verify against this address. Double-check that the wallet's 'Sign message' dropdown is set to the exact address you entered, and re-paste the signature.",
      );
    }

    const verifiedAt = new Date().toISOString();
    let stampTxid: string | null = null;
    if (video.video_wallet) {
      const stamp = await recordOwnershipAnchor({
        videoCid: video.cid,
        videoWallet: video.video_wallet,
        ownerWallet: data.ownerWallet,
      });
      stampTxid = stamp.real ? stamp.txid : null;
    }

    const { error: uErr } = await supabaseAdmin
      .from("videos")
      .update({
        owner_wallet: data.ownerWallet,
        owner_proof_status: "verified",
        owner_signature: data.signature,
        owner_verified_at: verifiedAt,
        ownership_tx_hash: stampTxid,
        owner_nonce: null,
      })
      .eq("cid", data.cid);
    if (uErr) throw new Error(uErr.message);

    // Auto-release any escrowed creator share that accrued while unverified.
    let releasedTxc = 0;
    let releaseTx: string | null = null;
    const escrowed = Number(video.escrowed_creator_txc ?? 0);
    if (escrowed > 0 && video.video_wallet) {
      try {
        const stamp = await recordSplitPayout({
          videoCid: video.cid,
          videoWallet: video.video_wallet,
          commentId: "escrow-release",
          toAddress: data.ownerWallet,
          amountTxc: escrowed,
          kind: "creator",
        });
        if (stamp) {
          releaseTx = stamp.txid;
          releasedTxc = escrowed;
          await supabaseAdmin
            .from("videos")
            .update({ escrowed_creator_txc: 0 })
            .eq("cid", data.cid);
        }
      } catch (err) {
        console.error("escrow release failed", err);
      }
    }

    return {
      verified: true,
      ownershipTxHash: stampTxid,
      releasedTxc,
      releaseTx,
    };
  });

// --- Comment payout sweep -------------------------------------------------

/**
 * Send the 90/5/5 split for one paid comment:
 *   - 5% → platform-labeled wallet address (always)
 *   - 5% → TXC_HOSTING_ADDRESS   (always)
 *   - 90% → owner_wallet          (only if owner_proof_status='verified',
 *                                   else accrue to videos.escrowed_creator_txc)
 * Idempotent: skips legs that already have a tx hash.
 */
export async function sweepCommentPayout(commentId: string): Promise<{
  ok: boolean;
  status: "swept" | "partial" | "escrowed" | "failed";
  details: Record<string, string>;
}> {
  const { data: comment } = await supabaseAdmin
    .from("comments")
    .select(
      "id, video_cid, payment_received_txc, payout_status, creator_payout_tx_hash, hosting_payout_tx_hash, platform_payout_tx_hash",
    )
    .eq("id", commentId)
    .maybeSingle();
  if (!comment) return { ok: false, status: "failed", details: { error: "comment not found" } };

  const { data: video } = await supabaseAdmin
    .from("videos")
    .select("cid, video_wallet, owner_wallet, owner_proof_status, escrowed_creator_txc")
    .eq("cid", comment.video_cid)
    .maybeSingle();
  if (!video) return { ok: false, status: "failed", details: { error: "video not found" } };

  const amount = Number(comment.payment_received_txc ?? 0);
  if (amount <= 0) return { ok: false, status: "failed", details: { error: "no payment" } };

  const hostingAddr = process.env.TXC_HOSTING_ADDRESS;
  if (!hostingAddr) {
    return {
      ok: false,
      status: "failed",
      details: { error: "TXC_HOSTING_ADDRESS not configured" },
    };
  }
  let platformAddr: string;
  try {
    platformAddr = await getPlatformAddress();
  } catch (e) {
    return {
      ok: false,
      status: "failed",
      details: { error: `Failed to resolve platform address: ${String(e)}` },
    };
  }

  const creatorAmt = +(amount * 0.9).toFixed(8);
  const hostingAmt = +(amount * 0.05).toFixed(8);
  const platformAmt = +(amount - creatorAmt - hostingAmt).toFixed(8);

  const updates: Record<string, string> = {
    payout_attempted_at: new Date().toISOString(),
  };
  const details: Record<string, string> = {};
  let allOk = true;

  // Platform leg
  if (!comment.platform_payout_tx_hash) {
    try {
      const r = await recordSplitPayout({
        videoCid: video.cid,
        videoWallet: video.video_wallet ?? platformAddr,
        commentId: comment.id,
        toAddress: platformAddr,
        amountTxc: platformAmt,
        kind: "platform",
      });
      if (r) updates.platform_payout_tx_hash = r.txid;
      details.platform = r?.txid ?? "skipped";
    } catch (e) {
      allOk = false;
      details.platform_error = String(e);
    }
  }

  // Hosting leg
  if (!comment.hosting_payout_tx_hash) {
    try {
      const r = await recordSplitPayout({
        videoCid: video.cid,
        videoWallet: video.video_wallet ?? hostingAddr,
        commentId: comment.id,
        toAddress: hostingAddr,
        amountTxc: hostingAmt,
        kind: "hosting",
      });
      if (r) updates.hosting_payout_tx_hash = r.txid;
      details.hosting = r?.txid ?? "skipped";
    } catch (e) {
      allOk = false;
      details.hosting_error = String(e);
    }
  }

  // Creator leg — only if verified, else escrow.
  let escrowed = false;
  if (!comment.creator_payout_tx_hash) {
    if (video.owner_proof_status === "verified" && video.owner_wallet) {
      try {
        const r = await recordSplitPayout({
          videoCid: video.cid,
          videoWallet: video.video_wallet ?? video.owner_wallet,
          commentId: comment.id,
          toAddress: video.owner_wallet,
          amountTxc: creatorAmt,
          kind: "creator",
        });
        if (r) updates.creator_payout_tx_hash = r.txid;
        details.creator = r?.txid ?? "skipped";
      } catch (e) {
        allOk = false;
        details.creator_error = String(e);
      }
    } else {
      escrowed = true;
      const newEscrow = Number(video.escrowed_creator_txc ?? 0) + creatorAmt;
      await supabaseAdmin
        .from("videos")
        .update({ escrowed_creator_txc: newEscrow })
        .eq("cid", video.cid);
      details.creator = "escrowed";
    }
  }

  const status: "swept" | "partial" | "escrowed" | "failed" = !allOk
    ? "partial"
    : escrowed
      ? "escrowed"
      : "swept";
  updates.payout_status = status === "swept" ? "swept" : status === "escrowed" ? "escrowed" : "partial";

  await supabaseAdmin
    .from("comments")
    .update(updates as never)
    .eq("id", commentId);
  return { ok: allOk, status, details };
}

/**
 * Manually re-attempt sweep for one comment from the UI (e.g. after an RPC
 * outage). Owner-only.
 */
export const retryCommentPayout = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        wallet: walletSchema,
        commentId: z.string().uuid(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { data: c } = await supabaseAdmin
      .from("comments")
      .select("video_cid")
      .eq("id", data.commentId)
      .maybeSingle();
    if (!c) throw new Error("Comment not found");
    const { data: v } = await supabaseAdmin
      .from("videos")
      .select("owner_wallet")
      .eq("cid", c.video_cid)
      .maybeSingle();
    if (!v || !ownerMatches(v.owner_wallet, wallet))
      throw new Error("Only the video owner can retry payouts");
    return await sweepCommentPayout(data.commentId);
  });