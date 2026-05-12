// Server-only helper: stamp a lifecycle event on TXC and persist it to
// public.chain_events. One canonical place so future events (renewals,
// takedowns, DMCA, payments) all flow through the same code path.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  stampEvent,
  stampRawPayload,
  TXC_PROTO_TAG,
  type TxcEventType,
  type StampResult,
} from "./txc.server";
import { pinJsonToIPFS } from "./pinata.server";
import { createHash } from "crypto";

export interface RecordChainEventInput {
  cid: string;
  videoWallet: string;
  eventType: TxcEventType;
  uploaderWallet: string;
  fromWallet?: string;
  extra?: string;
  metadata?: Record<string, unknown>;
}

export async function recordChainEvent(
  input: RecordChainEventInput,
): Promise<StampResult> {
  let stamp: StampResult;
  try {
    stamp = await stampEvent({
      cid: input.cid,
      wallet: input.uploaderWallet,
      eventType: input.eventType,
      toAddress: input.videoWallet,
      extra: input.extra,
    });
  } catch (err) {
    // Chain broadcast failed (RPC down, insufficient funds, dust, etc.) —
    // don't take the whole upload down with it. Generate a placeholder
    // txid, log loudly, and return so the video still saves. Operator can
    // re-stamp later from the chain_events row.
    console.error("recordChainEvent: stamp broadcast failed", err);
    const fakeTxid = createHash("sha256")
      .update(`pending:${input.cid}:${input.eventType}:${Date.now()}`)
      .digest("hex");
    stamp = {
      txid: fakeTxid,
      payload: `${input.eventType}|${input.cid}|${input.videoWallet}`,
      real: false,
    };
  }

  const { error } = await supabaseAdmin.from("chain_events").insert({
    video_cid: input.cid,
    video_wallet: input.videoWallet,
    event_type: input.eventType,
    tx_hash: stamp.txid,
    op_return_payload: stamp.payload,
    from_wallet: input.fromWallet ?? null,
    to_wallet: input.videoWallet,
    status: stamp.real ? "mempool" : "stamp_failed",
    metadata: (input.metadata ?? null) as never,
  });
  if (error) {
    // Don't fail the whole flow if the log write hiccups — the OP_RETURN is
    // already on the wire. Surface in server logs instead.
    console.error("recordChainEvent: failed to insert event row", error);
  }

  return stamp;
}

/**
 * Pin a metadata JSON blob (title + description + uploader + timestamp) to
 * IPFS, then stamp the resulting CID on TXC as a "T" event. Returns the
 * metadata CID and the stamp result so the caller can persist both. If
 * pinning succeeds but the chain stamp fails, we still return the metaCid
 * — the JSON is already content-addressed on IPFS, the operator can
 * re-stamp later from the chain_events row.
 */
export async function recordMetadataAnchor(input: {
  videoCid: string;
  videoWallet: string;
  uploaderWallet: string;
  title: string;
  description: string;
  thumbnailCid?: string | null;
}): Promise<{ metaCid: string; stamp: StampResult } | null> {
  // Build the canonical metadata blob. Field order matters for the CID, so
  // keep it stable across versions — bump `v` if the schema ever changes.
  // v2 adds optional `thumbnailCid` so creators can ship (and later edit)
  // a poster image without re-uploading the video. Older v1 readers can
  // safely ignore the new field.
  const meta = {
    v: 2,
    videoCid: input.videoCid,
    videoWallet: input.videoWallet,
    uploader: input.uploaderWallet,
    title: input.title,
    description: input.description ?? "",
    thumbnailCid: input.thumbnailCid ?? null,
    ts: new Date().toISOString(),
  };

  let metaCid: string;
  try {
    const pin = await pinJsonToIPFS(meta, `${input.videoCid}.meta.json`);
    metaCid = pin.cid;
  } catch (err) {
    console.error("recordMetadataAnchor: failed to pin metadata", err);
    return null;
  }

  // Payload: TXCV1T|<metaCid>  (~66 bytes for a CIDv1 bafy)
  const payload = `${TXC_PROTO_TAG}T|${metaCid}`;

  let stamp: StampResult;
  try {
    stamp = await stampRawPayload({
      payload,
      toAddress: input.videoWallet,
    });
  } catch (err) {
    console.error("recordMetadataAnchor: stamp broadcast failed", err);
    const fakeTxid = createHash("sha256")
      .update(`pending:${input.videoCid}:T:${Date.now()}`)
      .digest("hex");
    stamp = { txid: fakeTxid, payload, real: false };
  }

  const { error } = await supabaseAdmin.from("chain_events").insert({
    video_cid: input.videoCid,
    video_wallet: input.videoWallet,
    event_type: "T",
    tx_hash: stamp.txid,
    op_return_payload: stamp.payload,
    from_wallet: null,
    to_wallet: input.videoWallet,
    status: stamp.real ? "mempool" : "stamp_failed",
    metadata: { metaCid, title: input.title } as never,
  });
  if (error) {
    console.error("recordMetadataAnchor: failed to insert event row", error);
  }

  return { metaCid, stamp };
}