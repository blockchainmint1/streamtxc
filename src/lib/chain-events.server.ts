// Server-only helper: stamp a lifecycle event on TXC and persist it to
// public.chain_events. One canonical place so future events (renewals,
// takedowns, DMCA, payments) all flow through the same code path.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { stampEvent, type TxcEventType, type StampResult } from "./txc.server";
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