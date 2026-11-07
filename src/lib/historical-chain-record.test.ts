/// <reference types="bun" />
import { expect, test } from "bun:test";
import { historicalPayload, historicalRecord, isLegacyRandomRecord } from "./historical-chain-record";

const event = { id: "original-id", event_type: "P", video_cid: "original-video", video_wallet: "original-wallet", from_wallet: null, to_wallet: "original-wallet", tx_hash: "original-tx", op_return_payload: `TXCV1P|h:${"a".repeat(64)}`, metadata: { amount: 7 }, created_at: "2026-05-12T00:00:00Z" };
test("repair retains original history and never invents event-time ownership", () => {
  const record = historicalRecord(event);
  expect(record.original).toEqual(event);
  expect(record.kind).toBe("historical-supplement");
  expect(JSON.stringify(historicalRecord(event))).toBe(JSON.stringify(record));
});
test("repair excludes payouts, title records and already readable anchors", () => {
  expect(isLegacyRandomRecord({ event_type: "S", op_return_payload: `TXCV1S|h:${"a".repeat(64)}` })).toBe(false);
  expect(isLegacyRandomRecord({ event_type: "T", op_return_payload: `TXCV1T|h:${"a".repeat(64)}` })).toBe(false);
  expect(isLegacyRandomRecord({ event_type: "P", op_return_payload: "TXCV1P|bafyrecord" })).toBe(false);
});
test("historical record CID fits the 80-byte on-chain limit", () => {
  const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  expect(historicalPayload("P", cid)).toBe(`TXCV1P|${cid}`);
  expect(new TextEncoder().encode(historicalPayload("P", cid)).length).toBeLessThanOrEqual(80);
  expect(() => historicalPayload("P", "b".repeat(81))).toThrow();
});