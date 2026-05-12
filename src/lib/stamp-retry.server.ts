// Server-only helper to re-stamp videos whose initial C/T broadcast
// failed (typically because the TXC hot wallet was empty at upload time).
//
// Strategy:
//   - For the C event: re-run stampEvent. If a fresh real txid lands,
//     update the most recent stamp_failed C row + the videos row.
//   - For the T event: reuse the metaCid we already pinned to IPFS
//     (stored in chain_events.metadata.metaCid for the failed T row),
//     so we don't burn a fresh Pinata pin on every retry. If we can't
//     find one, fall back to re-pinning from the current videos row.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  stampEvent,
  stampRawPayload,
  TXC_PROTO_TAG,
} from "./txc.server";
import { pinJsonToIPFS } from "./pinata.server";

export interface RetryResult {
  cid: string;
  cStamp: { ok: boolean; txid?: string; error?: string };
  tStamp: { ok: boolean; txid?: string; metaCid?: string; error?: string };
  videoStatus: string;
}

export async function retryStuckStampForVideo(cid: string): Promise<RetryResult> {
  const { data: video, error: vErr } = await supabaseAdmin
    .from("videos")
    .select(
      "cid, owner_wallet, video_wallet, status, tx_hash, metadata_cid, title, description, thumbnail_cid",
    )
    .eq("cid", cid)
    .maybeSingle();
  if (vErr) throw new Error(vErr.message);
  if (!video) throw new Error(`video not found: ${cid}`);

  const result: RetryResult = {
    cid,
    cStamp: { ok: false },
    tStamp: { ok: false },
    videoStatus: video.status,
  };

  const videoWallet = video.video_wallet as string;

  // --- C event ---------------------------------------------------------
  if (!video.tx_hash || video.status === "stamp_failed") {
    try {
      const stamp = await stampEvent({
        cid: video.cid,
        wallet: video.owner_wallet,
        eventType: "C",
        toAddress: videoWallet,
      });
      if (stamp.real) {
        // Update the most recent failed C event row (if any) so its tx_hash
        // matches what's actually on chain.
        const { data: failedC } = await supabaseAdmin
          .from("chain_events")
          .select("id")
          .eq("video_cid", cid)
          .eq("event_type", "C")
          .eq("status", "stamp_failed")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (failedC) {
          await supabaseAdmin
            .from("chain_events")
            .update({
              tx_hash: stamp.txid,
              op_return_payload: stamp.payload,
              status: "mempool",
            })
            .eq("id", failedC.id);
        } else {
          await supabaseAdmin.from("chain_events").insert({
            video_cid: cid,
            video_wallet: videoWallet,
            event_type: "C",
            tx_hash: stamp.txid,
            op_return_payload: stamp.payload,
            from_wallet: null,
            to_wallet: videoWallet,
            status: "mempool",
          });
        }
        await supabaseAdmin
          .from("videos")
          .update({
            status: "mempool",
            tx_hash: stamp.txid,
            op_return_payload: stamp.payload,
          })
          .eq("cid", cid);
        result.cStamp = { ok: true, txid: stamp.txid };
        result.videoStatus = "mempool";
      } else {
        result.cStamp = { ok: false, error: "stub mode (no RPC configured)" };
      }
    } catch (err) {
      result.cStamp = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    result.cStamp = { ok: true, txid: video.tx_hash };
  }

  // --- T event ---------------------------------------------------------
  // Find an existing T chain_event for this video (failed or otherwise).
  const { data: existingT } = await supabaseAdmin
    .from("chain_events")
    .select("id, status, tx_hash, metadata")
    .eq("video_cid", cid)
    .eq("event_type", "T")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const needsTRetry =
    !existingT || existingT.status === "stamp_failed" || !video.metadata_cid;

  if (needsTRetry) {
    try {
      // Reuse the already-pinned metaCid if we have one — saves a Pinata pin.
      let metaCid: string | null =
        video.metadata_cid ||
        (existingT?.metadata as { metaCid?: string } | null)?.metaCid ||
        null;

      if (!metaCid) {
        const meta = {
          v: 2,
          videoCid: cid,
          videoWallet,
          uploader: video.owner_wallet,
          title: video.title,
          description: video.description ?? "",
          thumbnailCid: video.thumbnail_cid ?? null,
          ts: new Date().toISOString(),
        };
        const pin = await pinJsonToIPFS(meta, `${cid}.meta.json`);
        metaCid = pin.cid;
      }

      const payload = `${TXC_PROTO_TAG}T|${metaCid}`;
      const stamp = await stampRawPayload({ payload, toAddress: videoWallet });

      if (stamp.real) {
        if (existingT) {
          await supabaseAdmin
            .from("chain_events")
            .update({
              tx_hash: stamp.txid,
              op_return_payload: stamp.payload,
              status: "mempool",
              metadata: { metaCid, title: video.title } as never,
            })
            .eq("id", existingT.id);
        } else {
          await supabaseAdmin.from("chain_events").insert({
            video_cid: cid,
            video_wallet: videoWallet,
            event_type: "T",
            tx_hash: stamp.txid,
            op_return_payload: stamp.payload,
            from_wallet: null,
            to_wallet: videoWallet,
            status: "mempool",
            metadata: { metaCid, title: video.title } as never,
          });
        }
        if (!video.metadata_cid && metaCid) {
          await supabaseAdmin
            .from("videos")
            .update({ metadata_cid: metaCid })
            .eq("cid", cid);
        }
        result.tStamp = { ok: true, txid: stamp.txid, metaCid: metaCid ?? undefined };
      } else {
        result.tStamp = { ok: false, metaCid: metaCid ?? undefined, error: "stub mode" };
      }
    } catch (err) {
      result.tStamp = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    result.tStamp = { ok: true, txid: existingT.tx_hash, metaCid: video.metadata_cid ?? undefined };
  }

  return result;
}

export async function retryAllStuckStamps(): Promise<RetryResult[]> {
  const { data: stuck, error } = await supabaseAdmin
    .from("videos")
    .select("cid")
    .eq("status", "stamp_failed");
  if (error) throw new Error(error.message);
  const out: RetryResult[] = [];
  for (const row of stuck ?? []) {
    try {
      out.push(await retryStuckStampForVideo(row.cid));
    } catch (err) {
      out.push({
        cid: row.cid,
        cStamp: { ok: false, error: err instanceof Error ? err.message : String(err) },
        tStamp: { ok: false },
        videoStatus: "stamp_failed",
      });
    }
  }
  return out;
}