// Operator-only, not an HTTP endpoint. Secrets are read from the environment.
// Run serially. Interrupted prepared jobs rebroadcast identical signed bytes.
import { createClient } from "@supabase/supabase-js";
import { isLegacyRandomRecord, historicalRecord, historicalPayload } from "../src/lib/historical-chain-record";
import { verifyHistoricalPayload, prepareHistoricalStamp, broadcastHistoricalStamp } from "../src/lib/txc.server";
import { pinJsonToIPFS, fetchGateway } from "../src/lib/ipfs.server";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing privileged database configuration");
const db = createClient(url, key, { auth: { persistSession: false } });
const limit = Number(process.argv[2] ?? 10);
if (!Number.isInteger(limit) || limit < 1 || limit > 543) throw new Error("Invalid batch limit");
function checked<T extends { error: unknown }>(result: T): T {
  if (result.error) throw new Error("Repair journal operation failed");
  return result;
}

const events = checked(await db.from("chain_events").select("*").order("created_at").limit(2000)).data ?? [];
let completed = 0;
let skipped = 0;
for (const event of events.filter(isLegacyRandomRecord)) {
  if (completed >= limit) break;
  let journal = checked(await db.from("chain_record_repairs").select("*").eq("source_event_id", event.id).maybeSingle()).data;
  if (journal?.state === "complete") continue;
  if (!journal) {
    if (!await verifyHistoricalPayload(event.tx_hash, event.op_return_payload)) {
      console.log(JSON.stringify({ skipped: event.id, reason: "Original payload not found on chain" }));
      skipped++;
      continue;
    }
    journal = checked(await db.from("chain_record_repairs").insert({ source_event_id: event.id, record_json: historicalRecord(event) }).select("*").single()).data;
  }
  if (!journal) throw new Error("Missing journal");
  if (journal.state === "preparing") throw new Error("Interrupted preparation needs review; no automatic new transaction");
  if (journal.state === "pending") {
    if (!journal.record_cid) {
      const pin = await pinJsonToIPFS(journal.record_json, `${event.id}.historical-record.json`);
      journal = checked(await db.from("chain_record_repairs").update({ record_cid: pin.cid, payload: historicalPayload(event.event_type, pin.cid) }).eq("source_event_id", event.id).select("*").single()).data;
    }
    if (!journal?.payload) throw new Error("Missing pinned payload");
    // A new pin can take a few seconds to reach the gateway. Persist its CID
    // first, then read it back on every attempt; never spend on an unread file.
    let verified = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetchGateway(`https://node.ipfs.honest.money/ipfs/${journal.record_cid}`);
      if (response.ok) {
        if (JSON.stringify(await response.json()) !== JSON.stringify(journal.record_json)) throw new Error("Pinned record contents differ");
        verified = true;
        break;
      }
      console.log(JSON.stringify({ eventId: event.id, readStatus: response.status, attempt: attempt + 1 }));
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
    if (!verified) throw new Error("Pinned historical record unavailable; no transaction prepared");
    const claim = checked(await db.from("chain_record_repairs").update({ state: "preparing" }).eq("source_event_id", event.id).eq("state", "pending").select("*")).data;
    if (claim?.length !== 1) throw new Error("Repair already claimed");
    const recipient = event.to_wallet ?? event.video_wallet;
    if (!recipient) throw new Error("Missing original recipient");
    const prepared = await prepareHistoricalStamp(journal.payload, recipient);
    journal = checked(await db.from("chain_record_repairs").update({ state: "prepared", signed_tx_hex: prepared.signedHex, tx_hash: prepared.txid, fee_txc: prepared.fee }).eq("source_event_id", event.id).select("*").single()).data;
  }
  if (!journal?.signed_tx_hex || !journal.tx_hash) throw new Error("Missing prepared transaction");
  await broadcastHistoricalStamp(journal.signed_tx_hex, journal.tx_hash);
  checked(await db.from("chain_events").upsert({
    id: journal.replacement_event_id,
    video_cid: event.video_cid,
    video_wallet: event.video_wallet,
    event_type: event.event_type,
    tx_hash: journal.tx_hash,
    op_return_payload: journal.payload,
    from_wallet: event.from_wallet,
    to_wallet: event.to_wallet,
    status: "mempool",
    metadata: { historical_repair: true, original_event_id: event.id, original_tx_hash: event.tx_hash, recordCid: journal.record_cid },
  }, { onConflict: "id" }));
  checked(await db.from("chain_record_repairs").update({ state: "complete", completed_at: new Date().toISOString() }).eq("source_event_id", event.id));
  completed++;
  console.log(JSON.stringify({ completed, eventId: event.id, recordCid: journal.record_cid, txid: journal.tx_hash, feeTxc: journal.fee_txc }));
}
console.log(JSON.stringify({ completed, skipped }));