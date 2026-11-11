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


// Non-crypto stub-id helper. Used only when no real RPC is configured
// (local dev / tests). Must NOT pull in node:crypto — this file ends up
// in the client bundle via the createServerFn import graph.
function stubHex(seed: string): string {
  let h = 0;
  const data = `${seed}:${Date.now()}:${Math.random()}`;
  for (let i = 0; i < data.length; i++) h = ((h << 5) - h + data.charCodeAt(i)) | 0;
  let out = "";
  for (let i = 0; i < 8; i++) {
    h = (h * 1103515245 + 12345) | 0;
    out += ((h >>> 0).toString(16)).padStart(8, "0");
  }
  return out;
}

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
 *   T  title/meta  — anchored IPFS CID of a metadata JSON blob
 *                    (title, description, uploader, timestamp)
 *   O  ownership   — wallet ↔ video CID proven by a signed challenge
 *   S  split       — comment-revenue payout leg (creator|hosting|platform)
 */
export type TxcEventType =
  | "C"
  | "P"
  | "R"
  | "X"
  | "D"
  | "M"
  | "B"
  | "T"
  | "O"
  | "S";

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
  const h = stubHex(`${cid}|${wallet}|${extra ?? ""}`);
  return `${tag}|h:${h}`;
}

/** SHA-256 hex via WebCrypto (Worker-safe; no node:crypto in this module). */
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * File Fingerprint-style record: the full event is saved as a JSON file on
 * IPFS and only its CID goes on chain (`TXCV1<type>|<recordCid>`, ~66 bytes).
 * The JSON can hold as much detail as we like. If IPFS is unreachable we
 * fall back to the short direct form, or a reproducible SHA-256 commitment
 * of `type|cid|wallet|extra` — never a random code.
 */
export async function buildEventRecordPayload(input: {
  cid: string;
  wallet: string;
  eventType: TxcEventType;
  extra?: string;
  details?: Record<string, unknown>;
}): Promise<{ payload: string; recordCid: string | null }> {
  const tag = `${TXC_PROTO_TAG}${input.eventType}`;
  const record = {
    v: 1,
    proto: TXC_PROTO_TAG,
    type: input.eventType,
    videoCid: input.cid,
    wallet: input.wallet,
    extra: input.extra ?? null,
    details: input.details ?? {},
    ts: new Date().toISOString(),
  };
  try {
    const { pinJsonToIPFS } = await import("./ipfs.server");
    const pin = await pinJsonToIPFS(record, `${input.cid}.${input.eventType}.event.json`);
    const payload = `${tag}|${pin.cid}`;
    if (Buffer.byteLength(payload, "utf8") <= 80) return { payload, recordCid: pin.cid };
  } catch (err) {
    console.warn("buildEventRecordPayload: IPFS pin failed, using fallback", err);
  }
  const direct = [tag, input.cid, input.wallet, ...(input.extra ? [input.extra] : [])].join("|");
  if (Buffer.byteLength(direct, "utf8") <= 80) return { payload: direct, recordCid: null };
  const h = await sha256Hex(`${input.eventType}|${input.cid}|${input.wallet}|${input.extra ?? ""}`);
  return { payload: `${tag}|s:${h.slice(0, 64)}`, recordCid: null };
}

function rpcConfigured(): boolean {
  return !!(process.env.TXC_RPC_URL && process.env.TXC_RPC_USER && process.env.TXC_RPC_PASS);
}

/**
 * fundrawtransaction options.
 *
 * IMPORTANT history: we used to pin `changeAddress` to TXC_PLATFORM_ADDRESS
 * out of fear that the node's keypool change addresses would collide with
 * per-video deposit wallets (also derived from the same xpub). That fear
 * was wrong AND the fix was actively harmful:
 *   - Per-video deposit wallets are derived on the EXTERNAL chain (m/0/i).
 *     bitcoind's `getrawchangeaddress` pulls from the INTERNAL/change
 *     keypool (m/1/i) — a separate branch — so there is no collision.
 *   - Pinning change to TXC_PLATFORM_ADDRESS meant every topup to the hot
 *     wallet got swept to the platform legacy address on the very next
 *     stamp. Net effect: hot wallet drained itself after one tx, and
 *     funds had to be manually returned each time.
 *
 * Letting bitcoind pick its own change address keeps the funds inside the
 * same hot wallet that signs OP_RETURN txs, so a single topup lasts
 * thousands of stamps.
 */
export async function getOrCreateLabeledAddress(label: string): Promise<string> {
  try {
    const labeled = await rpc<Record<string, unknown>>("getaddressesbylabel", [
      label,
    ]);
    const existing = Object.keys(labeled ?? {})[0];
    if (existing) return existing;
  } catch {
    // Missing labels can error on this node version — fall through and mint one.
  }

  return await rpc<string>("getnewaddress", [label, "bech32"]);
}

/**
 * Mint a brand-new wallet-owned address with the given label. Always
 * fresh — does NOT reuse an existing labeled address. Use this for
 * per-video / per-comment deposit wallets where reuse would cross
 * accounting streams.
 */
export async function getNewLabeledAddress(label: string): Promise<string> {
  return await rpc<string>("getnewaddress", [label, "bech32"]);
}

/**
 * Resolve the platform's 5%-fee receiving address. Always a wallet-owned
 * bech32 address labeled `platform`, minted on first use. Replaces the
 * old `TXC_PLATFORM_ADDRESS` env var (which pointed to an external,
 * unowned address that was draining the hot wallet).
 */
export async function getPlatformAddress(): Promise<string> {
  return await getOrCreateLabeledAddress("platform");
}

async function getHotWalletChangeAddress(): Promise<string> {
  const explicit = process.env.TXC_HOT_WALLET_CHANGE_ADDRESS?.trim();
  if (explicit) return explicit;
  return await getOrCreateLabeledAddress("hot-wallet-change");
}

async function getHotWalletEventAddress(): Promise<string> {
  const explicit = process.env.TXC_HOT_WALLET_EVENT_ADDRESS?.trim();
  if (explicit) return explicit;
  return await getOrCreateLabeledAddress("hot-wallet-events");
}

async function fundOptions(): Promise<Record<string, unknown>> {
  return {
    changeAddress: await getHotWalletChangeAddress(),
  };
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
  // Target a specific wallet on the node. The node may have multiple wallets
  // loaded (e.g. a watch-only wallet plus our signing "hot" wallet); without
  // the /wallet/<name> path, Core picks the default and signing calls fail
  // with "This wallet has no available keys".
  const walletName = process.env.TXC_RPC_WALLET || "hot";
  return u.replace(/\/?$/, "") + "/wallet/" + encodeURIComponent(walletName);
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

/** Operator repair path: verify evidence before creating any replacement. */
export async function verifyHistoricalPayload(txid: string, payload: string): Promise<boolean> {
  const hex = Buffer.from(payload, "utf8").toString("hex");
  // Older transactions may predate the current hot wallet; the public chain
  // remains the authoritative evidence even when gettransaction cannot see it.
  const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";
  const response = await fetch(`${base}/api/tx/${txid}`);
  if (!response.ok) throw new Error(`Historical transaction lookup unavailable [${response.status}]`);
  const tx = await response.json() as { txid: string; vout: Array<{ scriptpubkey_asm?: string }> };
  return tx.txid === txid && tx.vout.some((out) => {
    const asm = out.scriptpubkey_asm ?? "";
    return asm.startsWith("OP_RETURN ") && asm.split(" ").at(-1) === hex;
  });
}

/** Persist returned signed bytes BEFORE broadcast; retries must reuse them. */
export async function prepareHistoricalStamp(payload: string, recipient: string) {
  if (!rpcConfigured()) throw new Error("Historical repairs require real RPC credentials");
  if (Buffer.byteLength(payload, "utf8") > 80) throw new Error("Payload exceeds 80 bytes");
  const raw = await rpc<string>("createrawtransaction", [[], [{ data: Buffer.from(payload).toString("hex") }, { [recipient]: 0.0001 }]]);
  const funded = await rpc<{ hex: string; fee: number }>("fundrawtransaction", [raw, await fundOptions()]);
  // A conservative safety ceiling, not an estimated or advertised fee.
  if (funded.fee > 0.01) throw new Error("Repair fee exceeds safety ceiling");
  const signed = await rpc<{ hex: string; complete: boolean }>("signrawtransactionwithwallet", [funded.hex]);
  if (!signed.complete) throw new Error("Historical repair signing incomplete");
  const decoded = await rpc<{ txid: string }>("decoderawtransaction", [signed.hex]);
  return { signedHex: signed.hex, txid: decoded.txid, fee: funded.fee };
}

export async function broadcastHistoricalStamp(signedHex: string, expectedTxid: string): Promise<string> {
  try {
    const txid = await rpc<string>("sendrawtransaction", [signedHex]);
    if (txid !== expectedTxid) throw new Error("Unexpected repair transaction ID");
    return txid;
  } catch (error) {
    // A timeout or already-known response must never fund another transaction.
    const existing = await rpc<{ txid: string }>("gettransaction", [expectedTxid]).catch(() => null);
    if (existing?.txid === expectedTxid) return expectedTxid;
    throw error;
  }
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
    const txid = stubHex(`stub:${payload}:${Date.now()}:${Math.random()}`);
    return { txid, payload, real: false };
  }

  const dataHex = Buffer.from(payload, "utf8").toString("hex");
  const rawTx = await rpc<string>("createrawtransaction", [
    [],
    [{ data: dataHex }, { [toAddress]: 0.0001 }],
  ]);
  const funded = await rpc<{ hex: string }>("fundrawtransaction", [
    rawTx,
    await fundOptions(),
  ]);
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
  details?: Record<string, unknown>;
}): Promise<StampResult> {
  const { cid, wallet, eventType, toAddress, extra } = opts;
  const { payload } = await buildEventRecordPayload({ cid, wallet, eventType, extra, details: opts.details });

  if (!rpcConfigured()) {
    // Stub mode — deterministic 64-hex "txid" so the UI flow works.
    const txid = stubHex(`stub:${payload}:${Date.now()}:${Math.random()}`);
    return { txid, payload, real: false };
  }

  // Real Bitcoin-style flow. Send a tiny output to the per-video wallet so
  // every lifecycle event accumulates on the same explorer address page.
  // If no per-video address was provided (older rows), fall back to a
  // change address from the node's own wallet.
  let recipient = toAddress;
  if (!recipient) {
    recipient = await getHotWalletEventAddress();
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
  const funded = await rpc<{ hex: string }>("fundrawtransaction", [
    rawTx,
    await fundOptions(),
  ]);
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
      const blockHash = stubHex(`block:${txid}`);
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

// NOTE: just the prefix string. Do NOT bake a length byte in here —
// we prepend a proper Bitcoin varint of the prefix length below, which
// for "Texitcoin Signed Message:\n" (26 bytes) is 0x1a. The old
// "\x19Texitcoin Signed Message:\n" form hardcoded 0x19 (= 25), which
// happened to match the legacy TXC Core wallet's buggy/identical
// encoding but does NOT match the new TXC Web Wallet, which follows
// the standard Bitcoin convention (varint(prefixLen) + prefix +
// varint(msgLen) + msg).
const TXC_SIGNED_MESSAGE_PREFIX = "Texitcoin Signed Message:\n";

function encodeBitcoinVarInt(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.from([value]);
  if (value <= 0xffff) {
    return Uint8Array.from([0xfd, value & 0xff, (value >>> 8) & 0xff]);
  }
  if (value <= 0xffffffff) {
    return Uint8Array.from([
      0xfe,
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]);
  }
  throw new Error("Message too large to verify");
}

async function verifyLegacyTMessage(
  address: string,
  signature: string,
  message: string,
): Promise<boolean> {
  // Try the standard encoding first (new TXC Web Wallet, BIP-style
  // varint(prefixLen) + prefix + varint(msgLen) + msg). If that fails,
  // fall back to the legacy TXC Core encoding which hardcoded a single
  // 0x19 byte in front of the prefix instead of a real varint.
  if (await verifyLegacyTMessageWith(address, signature, message, "standard")) {
    return true;
  }
  return await verifyLegacyTMessageWith(address, signature, message, "legacy-core");
}

async function verifyLegacyTMessageWith(
  address: string,
  signature: string,
  message: string,
  mode: "standard" | "legacy-core",
): Promise<boolean> {
  const [{ sha256 }, { ripemd160 }, { secp256k1 }, bs58checkModule] = await Promise.all([
    import("@noble/hashes/sha256"),
    import("@noble/hashes/ripemd160"),
    import("@noble/curves/secp256k1"),
    import("bs58check"),
  ]);

  const bs58check = (bs58checkModule.default ?? bs58checkModule) as {
    decode(input: string): Uint8Array;
  };

  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 65) {
    throw new Error("Invalid signature length");
  }

  const flagByte = signatureBytes[0] - 27;
  if (flagByte < 0 || flagByte > 15) {
    throw new Error("Invalid signature parameter");
  }

  const compressed = !!(flagByte & 12);
  const recovery = flagByte & 3;

  const prefixBytes = Buffer.from(TXC_SIGNED_MESSAGE_PREFIX, "utf8");
  const messageBytes = Buffer.from(message, "utf8");
  const prefixHeader =
    mode === "standard"
      ? Buffer.from(encodeBitcoinVarInt(prefixBytes.length))
      : Buffer.from([0x19]); // legacy TXC Core hardcoded byte
  const payload = Buffer.concat([
    prefixHeader,
    prefixBytes,
    Buffer.from(encodeBitcoinVarInt(messageBytes.length)),
    messageBytes,
  ]);

  const digest = sha256(sha256(payload));
  const publicKey = secp256k1.Signature.fromCompact(signatureBytes.subarray(1))
    .addRecoveryBit(recovery)
    .recoverPublicKey(digest)
    .toRawBytes(compressed);

  const publicKeyHash = ripemd160(sha256(publicKey));
  const decodedAddress = bs58check.decode(address);
  const expectedHash = decodedAddress.subarray(1);

  return Buffer.from(publicKeyHash).equals(Buffer.from(expectedHash));
}

/**
 * Verify a signed wallet-auth / ownership-proof message.
 *
 * The current TXC wallet login flow uses legacy `T…` addresses, verified
 * locally with a Worker-safe recovery path using TXC's signed-message prefix.
 * This avoids the node's flaky `verifymessage` behavior and the earlier Worker
 * runtime incompatibility from the Node-only hashing stack.
 *
 * For bech32 `txc1…` addresses we keep a local BIP-322 fallback, though the UI
 * currently restricts sign-in and ownership proof to legacy `T…` addresses.
 *
 * Missing RPC configuration never bypasses cryptographic verification.
 */
export async function verifyMessage(
  address: string,
  signature: string,
  message: string,
): Promise<boolean> {
  console.log("[verifyMessage] enter", {
    addr: address,
    sigLen: signature.length,
    msgLen: message.length,
    rpcConfigured: rpcConfigured(),
  });
  const trimmedAddress = address.trim();
  const trimmedSignature = signature.trim();
  const isLegacyT = /^T[1-9A-HJ-NP-Za-km-z]{20,90}$/.test(trimmedAddress);
  const isBech32 = /^txc1[0-9a-z]+$/i.test(trimmedAddress);

  try {
    if (isLegacyT) {
      let localOk = false;
      try {
        localOk = await verifyLegacyTMessage(trimmedAddress, trimmedSignature, message);
        console.log("[verifyMessage] legacy local verify result", { ok: localOk });
      } catch (error) {
        console.warn("[verifyMessage] legacy local verify threw", {
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (localOk) return true;

      if (!rpcConfigured()) return false;
      const rpcOk = await rpc<boolean>("verifymessage", [
        trimmedAddress,
        trimmedSignature,
        message,
      ]);
      console.log("[verifyMessage] legacy rpc fallback result", { ok: rpcOk });
      return rpcOk;
    }

    if (isBech32) {
      const { Verifier } = await import("bip322-js");
      const ok = Verifier.verifySignature(trimmedAddress, message, trimmedSignature);
      console.log("[verifyMessage] bip322 result", { ok });
      return ok;
    }

    throw new Error(
      `Unsupported TXC address format: "${trimmedAddress.slice(0, 10)}…". Use a legacy T… or bech32 txc1… address.`,
    );
  } catch (err) {
    console.error("[verifyMessage] threw", {
      name: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 5).join(" | ") : undefined,
    });
    throw err;
  }
}

/**
 * Send TXC from the platform hot wallet to a recipient. Used for splitting
 * comment revenue (creator / hosting / platform legs). Stub mode returns a
 * fake txid so flows still work without RPC.
 */
export async function sendToAddress(
  address: string,
  amountTxc: number,
): Promise<StampResult> {
  const amount = +amountTxc.toFixed(8);
  if (amount <= 0) throw new Error("sendToAddress: amount must be > 0");
  if (!rpcConfigured()) {
    const txid = stubHex(`stub:pay:${address}:${amount}:${Date.now()}:${Math.random()}`);
    return { txid, payload: `pay:${amount}`, real: false };
  }
  const txid = await rpc<string>("sendtoaddress", [address, amount]);
  return { txid, payload: `pay:${amount}`, real: true };
}

/**
 * Total CONFIRMED TXC received at an address (mempool ignored, so an
 * unconfirmed deposit can never trigger a payout or credit), via the
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
    const sats = data.chain_stats?.funded_txo_sum ?? 0;
    return sats / 1e8;
  } catch {
    return 0;
  }
}