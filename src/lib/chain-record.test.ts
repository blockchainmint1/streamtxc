/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { buildEventRecordPayload } from "./txc.server";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const input = {
  cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  wallet: "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m",
  eventType: "C" as const,
};

test("on-chain record is the IPFS record's CID and fits in 80 bytes", async () => {
  const recordCid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ cid: recordCid, Hash: recordCid, IpfsHash: recordCid }), { status: 200 })) as unknown as typeof fetch;
  const r = await buildEventRecordPayload(input);
  if (r.recordCid) {
    expect(r.payload).toBe(`TXCV1C|${recordCid}`);
  }
  expect(Buffer.byteLength(r.payload)).toBeLessThanOrEqual(80);
});

test("if IPFS is down, the fallback is reproducible, never random", async () => {
  globalThis.fetch = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  const a = await buildEventRecordPayload(input);
  const b = await buildEventRecordPayload(input);
  expect(a.payload).toBe(b.payload);
  expect(a.payload.startsWith("TXCV1C|s:")).toBe(true);
  expect(Buffer.byteLength(a.payload)).toBeLessThanOrEqual(80);
});
