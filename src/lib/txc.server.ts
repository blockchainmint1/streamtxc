// TXC blockchain adapter (server-only).
//
// CHAIN FACTS (don't forget again):
//   - TEXITcoin (TXC) is a Layer 1 Scrypt PoW UTXO chain — Litecoin/Dogecoin
//     lineage, NOT a Bitcoin Core fork. Scrypt only changes the mining algo;
//     the tx format (incl. OP_RETURN ≤80 bytes) and JSON-RPC surface
//     (createrawtransaction / fundrawtransaction / signrawtransactionwithwallet
//     / sendrawtransaction) are inherited from the Bitcoin/Litecoin codebase,
//     so this adapter Just Works against a TXC node.
//   - Block explorer:  https://explorer.texitcoin.org
//   - Mempool (preferred for OP_RETURN inspection):
//                      https://mempool.texitcoin.org   ← canonical for our UI
//   - Web wallet:      https://wallet.texitcoin.org
//   - Project site:    https://texitcoin.org
//
// We deliberately link users to mempool.texitcoin.org instead of the block
// explorer because the mempool UI surfaces OP_RETURN payload data directly on
// the tx page, which is the whole point of our "on-chain proof" — readers
// need to see the CID anchored in the tx, not hunt for it.
//
// Real implementation: Bitcoin-style JSON-RPC against a TXC node. We build a
// transaction with one tiny self-pay output and one OP_RETURN output carrying
// our anchor payload, sign it with the platform hot wallet, broadcast it, and
// return the txid.
//
// Stub implementation: when the RPC env vars aren't set yet we generate a
// deterministic fake txid so the rest of the app (DB writes, watch page,
// mempool polling UI) works end-to-end. The adapter is the ONLY place that
// needs to change when real RPC creds land.

import { createHash } from "crypto";

export const TXC_PROTO_TAG = "TXCV1";

/**
 * Lifecycle event types stamped into OP_RETURN. The 1-char suffix keeps
 * the payload tiny so we always fit under the 80-byte limit.
 *   C  claim       — initial upload, video wallet created
 *   P  payment     — uploader paid the hosting fee
 *   R  renewal     — extended hosting period
 *   X  takedown    — pin removed (expired, opt-out, etc.)
 *   D  dmca        — DMCA / abuse complaint logged
 *   M  message     — pay-to-comment posted
 *   B  boost       — comment boost top-up
 */
export type TxcEventType = "C" | "P" | "R" | "X" | "D" | "M" | "B";

/** ≤80 bytes per the Bitcoin OP_RETURN standard data carrier limit. */
export function buildOpReturnPayload(
  cid: string,
  wallet: string,
  eventType: TxcEventType = "C",
  extra?: string,
): string {
  const short = wallet.startsWith("0x") ? wallet.slice(0, 12) : wallet;
  const tag = `${TXC_PROTO_TAG}${eventType}`;
  const parts = [tag, cid, short];
  if (extra) parts.push(extra);
  const direct = parts.join("|");
  if (Buffer.byteLength(direct, "utf8") <= 80) return direct;
  // Fallback: hash everything into a single 32-byte commitment.
  const h = createHash("sha256")
    .update(`${cid}|${wallet}|${extra ?? ""}`)
    .digest("hex");
  return `${tag}|h:${h}`;
}

function rpcConfigured(): boolean {
  return !!(process.env.TXC_RPC_URL && process.env.TXC_RPC_USER && process.env.TXC_RPC_PASS);
}

/**
 * Build the full RPC URL from env. Accepts either a complete URL
 * (`http://host:port`) or a bare host/IP plus optional `TXC_RPC_PORT`.
 */
function rpcUrl(): string {
  const raw = process.env.TXC_RPC_URL!;
  let u = raw.trim();
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  const hostPart = u.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const hasPort = /:\d+$/.test(hostPart);
  const isHttps = /^https:\/\//.test(u);
  if (!hasPort && !isHttps) {
    const port = process.env.TXC_RPC_PORT || "15739";
    u = u.replace(/\/?$/, "") + ":" + port;
  }
  return u;
}

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const url = rpcUrl();
  const user = process.env.TXC_RPC_USER!;
  const pass = process.env.TXC_RPC_PASS!;
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "txc", method, params }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (text.includes("error code: 1003")) {
      throw new Error(
        `TXC RPC ${method} failed [${res.status}]: the published app cannot reach a direct-IP or custom-port RPC endpoint. Point TXC_RPC_URL at an HTTPS hostname on port 443 instead.`,
      );
    }
    throw new Error(`TXC RPC ${method} failed [${res.status}]: ${text}`);
  }
  const json = (await res.json()) as { result: T; error: { message: string } | null };
  if (json.error) throw new Error(`TXC RPC ${method} error: ${json.error.message}`);
  return json.result;
}

export interface StampResult {
  txid: string;
  payload: string;
  /** True when the txid is a real on-chain tx; false for stub mode. */
  real: boolean;
}

/**
 * Anchor a comment on chain by referencing its IPFS CID. The full body
 * (and metadata: video CID, wallet, amount, timestamp) lives in a JSON
 * blob pinned to IPFS — the chain only carries the content-addressed
 * pointer:
 *
 *   TXCV1M|<commentCid>|<amount>
 *
 * Anyone can fetch the pinned JSON via any IPFS gateway and verify the
 * CID matches — the CID is the hash of the body, so tampering is
 * impossible.
 */
export async function stampCommentCid(opts: {
  commentCid: string;
  amountTxc: number;
  videoWallet: string;
}): Promise<StampResult> {
  const payload = `${TXC_PROTO_TAG}M|${opts.commentCid}|${opts.amountTxc.toFixed(4)}`;
  return stampRawPayload({ payload, toAddress: opts.videoWallet });
}

/** Broadcast an arbitrary OP_RETURN payload (≤80 bytes) to a recipient. */
export async function stampRawPayload(opts: {
  payload: string;
  toAddress: string;
}): Promise<StampResult> {
  const { payload, toAddress } = opts;
  if (Buffer.byteLength(payload, "utf8") > 80) {
    throw new Error(`OP_RETURN payload too long: ${payload.length} bytes`);
  }

  if (!rpcConfigured()) {
    const txid = createHash("sha256")
      .update(`stub:${payload}:${Date.now()}:${Math.random()}`)
      .digest("hex");
    return { txid, payload, real: false };
  }

  const dataHex = Buffer.from(payload, "utf8").toString("hex");
  const rawTx = await rpc<string>("createrawtransaction", [
    [],
    [{ data: dataHex }, { [toAddress]: 0.0001 }],
  ]);
  const funded = await rpc<{ hex: string }>("fundrawtransaction", [rawTx]);
  const signed = await rpc<{ hex: string; complete: boolean }>(
    "signrawtransactionwithwallet",
    [funded.hex],
  );
  if (!signed.complete) throw new Error("TXC tx signing incomplete");
  const txid = await rpc<string>("sendrawtransaction", [signed.hex]);
  return { txid, payload, real: true };
}

/**
 * Broadcast an OP_RETURN tx for a video lifecycle event on TXC.
 *
 * `toAddress` is the per-video wallet — every event for a given video is
 * sent to the same address so mempool.texitcoin.org/address/<addr> shows
 * the complete public history of that video.
 */
export async function stampEvent(opts: {
  cid: string;
  wallet: string;
  eventType: TxcEventType;
  toAddress?: string;
  extra?: string;
}): Promise<StampResult> {
  const { cid, wallet, eventType, toAddress, extra } = opts;
  const payload = buildOpReturnPayload(cid, wallet, eventType, extra);

  if (!rpcConfigured()) {
    // Stub mode — deterministic 64-hex "txid" so the UI flow works.
    const txid = createHash("sha256")
      .update(`stub:${payload}:${Date.now()}:${Math.random()}`)
      .digest("hex");
    return { txid, payload, real: false };
  }

  // Real Bitcoin-style flow. Send a tiny output to the per-video wallet so
  // every lifecycle event accumulates on the same explorer address page.
  // If no per-video address was provided (older rows), fall back to a
  // change address from the node's own wallet.
  let recipient = toAddress;
  if (!recipient) {
    recipient = process.env.TXC_PLATFORM_ADDRESS;
  }
  if (!recipient) {
    recipient = await rpc<string>("getrawchangeaddress", []);
  }

  // OP_RETURN data must be hex-encoded.
  const dataHex = Buffer.from(payload, "utf8").toString("hex");

  // Use createrawtransaction with empty inputs, then fundrawtransaction +
  // signrawtransactionwithwallet + sendrawtransaction. Standard bitcoind flow.
  // 0.0001 TXC (10k sats) — above the node's dust relay threshold for
  // P2WPKH outputs we observed on this chain.
  const rawTx = await rpc<string>("createrawtransaction", [
    [],
    [{ data: dataHex }, { [recipient]: 0.0001 }],
  ]);
  const funded = await rpc<{ hex: string }>("fundrawtransaction", [rawTx]);
  const signed = await rpc<{ hex: string; complete: boolean }>(
    "signrawtransactionwithwallet",
    [funded.hex],
  );
  if (!signed.complete) throw new Error("TXC tx signing incomplete");
  const txid = await rpc<string>("sendrawtransaction", [signed.hex]);

  return { txid, payload, real: true };
}

/** Backwards-compatible thin wrapper for the original claim-stamp flow. */
export async function stampCid(
  cid: string,
  wallet: string,
  toAddress?: string,
): Promise<StampResult> {
  return stampEvent({ cid, wallet, eventType: "C", toAddress });
}

export interface TxStatus {
  confirmed: boolean;
  blockHeight: number | null;
  blockHash: string | null;
}

/**
 * Look up confirmation status from mempool.texitcoin.org (esplora API).
 * For stub txids (not present on-chain) we fake confirmation after 60s so the
 * UI flow can be tested end-to-end without a real TXC wallet.
 */
export async function getTxStatus(
  txid: string,
  createdAt?: string | Date,
): Promise<TxStatus> {
  const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";
  try {
    const res = await fetch(`${base}/api/tx/${txid}`);
    if (res.ok) {
      const data = (await res.json()) as {
        status?: { confirmed?: boolean; block_height?: number; block_hash?: string };
      };
      const s = data.status;
      return {
        confirmed: !!s?.confirmed,
        blockHeight: s?.block_height ?? null,
        blockHash: s?.block_hash ?? null,
      };
    }
    // 404 → either stub txid OR real tx not yet propagated.
  } catch {
    // network error — fall through to stub behaviour
  }

  // Stub fallback: if we created the row at least 60s ago, mark confirmed
  // with a deterministic fake block. Lets us demo the full UX.
  if (!rpcConfigured() && createdAt) {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (ageMs > 60_000) {
      const blockHash = createHash("sha256").update(`block:${txid}`).digest("hex");
      const blockHeight = Math.floor(Date.now() / 600_000); // 10-min "blocks"
      return { confirmed: true, blockHeight, blockHash };
    }
  }

  return { confirmed: false, blockHeight: null, blockHash: null };
}

export function explorerTxUrl(txid: string): string {
  const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";
  return `${base}/tx/${txid}`;
}

/**
 * Total TXC received at an address (confirmed + mempool), via the
 * mempool.texitcoin.org esplora API. Returns 0 on any failure so callers
 * can treat "unknown" as "not yet paid".
 */
export async function getAddressReceived(address: string): Promise<number> {
  const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";
  try {
    const res = await fetch(`${base}/api/address/${address}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as {
      chain_stats?: { funded_txo_sum?: number };
      mempool_stats?: { funded_txo_sum?: number };
    };
    const sats =
      (data.chain_stats?.funded_txo_sum ?? 0) +
      (data.mempool_stats?.funded_txo_sum ?? 0);
    return sats / 1e8;
  } catch {
    return 0;
  }
}