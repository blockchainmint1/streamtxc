// Server-only helper: stamp a lifecycle event on TXC and persist it to
// public.chain_events. One canonical place so future events (renewals,
// takedowns, DMCA, payments) all flow through the same code path.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { stampEvent, type TxcEventType, type StampResult } from "./txc.server";

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
  const stamp = await stampEvent({
    cid: input.cid,
    wallet: input.uploaderWallet,
    eventType: input.eventType,
    toAddress: input.videoWallet,
    extra: input.extra,
  });

  const { error } = await supabaseAdmin.from("chain_events").insert({
    video_cid: input.cid,
    video_wallet: input.videoWallet,
    event_type: input.eventType,
    tx_hash: stamp.txid,
    op_return_payload: stamp.payload,
    from_wallet: input.fromWallet ?? null,
    to_wallet: input.videoWallet,
    status: "mempool",
    metadata: (input.metadata ?? null) as never,
  });
  if (error) {
    // Don't fail the whole flow if the log write hiccups — the OP_RETURN is
    // already on the wire. Surface in server logs instead.
    console.error("recordChainEvent: failed to insert event row", error);
  }

  return stamp;
}