// Frozen historical evidence, not a new upload/payment/ownership assertion.
export interface HistoricalEvent {
  id: string;
  event_type: string;
  video_cid: string;
  video_wallet: string | null;
  from_wallet: string | null;
  to_wallet: string | null;
  tx_hash: string;
  op_return_payload: string;
  metadata: unknown;
  created_at: string;
}

export function isLegacyRandomRecord(event: Pick<HistoricalEvent, "event_type" | "op_return_payload">): boolean {
  return /^[CPRXDMBO]$/.test(event.event_type) &&
    new RegExp(`^TXCV1${event.event_type}\\|h:[0-9a-f]{64}$`).test(event.op_return_payload);
}

export function historicalRecord(event: HistoricalEvent) {
  if (!isLegacyRandomRecord(event)) throw new Error("Not a legacy random-code event");
  return {
    v: 1,
    proto: "TXCV1",
    type: event.event_type,
    kind: "historical-supplement",
    videoCid: event.video_cid,
    original: { ...event },
    evidence: "Original recorded fields; original OP_RETURN verified on chain before repair",
    unknowns: ["Any event-time actor, amount, reason or signature not retained in the original row remains unknown"],
    effects: "Documentation only; no payment, renewal, takedown or ownership change",
  };
}

export function historicalPayload(type: string, cid: string): string {
  if (!/^[CPRXDMBO]$/.test(type) || !/^(b[a-z2-7]+|Qm[1-9A-HJ-NP-Za-km-z]+)$/.test(cid)) throw new Error("Invalid historical anchor");
  const payload = `TXCV1${type}|${cid}`;
  if (new TextEncoder().encode(payload).length > 80) throw new Error("Historical anchor exceeds 80 bytes");
  return payload;
}