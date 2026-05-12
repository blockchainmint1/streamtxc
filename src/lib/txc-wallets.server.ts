// Per-video TXC wallet derivation (server-only).
//
// ARCHITECTURE
// Every video gets its own TXC address derived from a platform xpub at a
// deterministic BIP44 path:
//
//   m / 44' / <txc-coin-type>' / 0' / 0 / <derivation_index>
//
// Where <derivation_index> comes from the `video_wallet_index_seq` sequence
// in Postgres (monotonic, never reused).
//
// Every on-chain lifecycle event for a video — claim, payment, renewal,
// takedown, DMCA — is sent TO this address. Result: one URL on
// mempool.texitcoin.org/address/<addr> shows the video's complete public
// history. Inspired by bevis.sg's per-asset wallet model.
//
// MODE: real BIP32 derivation when TXC_XPUB is configured; otherwise a
// deterministic stub for local dev. The xpub never needs the corresponding
// xprv on the server — public derivation along the m/0/<i> external chain
// is enough to generate receiving addresses. Spending from these addresses
// requires the xprv on a separate signer.

import { createHash } from "crypto";
import { HDKey } from "@scure/bip32";
import { base58check, bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// TXC native segwit (BIP84 / P2WPKH) bech32 HRP. Confirmed against the
// node: getnewaddress "" bech32 returned `txc1q…`. This matches the zpub
// the user provides, so addresses we derive will land in their wallet.
const TXC_BECH32_HRP = process.env.TXC_BECH32_HRP || "txc";

// Legacy P2PKH version byte, kept only for the dev-mode stub. Real
// receive addresses always go through the bech32 path.
const TXC_P2PKH_VERSION = process.env.TXC_P2PKH_VERSION
  ? Number(process.env.TXC_P2PKH_VERSION)
  : 0x42;

function hash160(pub: Uint8Array): Uint8Array {
  return ripemd160(sha256(pub));
}

/**
 * Encode a 20-byte hash160 as a BIP173 bech32 P2WPKH address (witness
 * version 0). Matches `getnewaddress "" bech32` output on the TXC node.
 */
function p2wpkhAddress(pub: Uint8Array): string {
  const program = hash160(pub); // 20 bytes
  const words = bech32.toWords(program);
  // Witness version 0 prepended (5-bit word).
  return bech32.encode(TXC_BECH32_HRP, [0, ...words]);
}

let cachedExternal: HDKey | null = null;
function externalChain(): HDKey | null {
  if (cachedExternal) return cachedExternal;
  const xpub = process.env.TXC_XPUB;
  if (!xpub) return null;
  // We accept BIP84 zpub (native segwit account key, depth 3, m/84'/c'/0').
  // @scure/bip32 only knows BIP32 xpub version bytes, so we read the actual
  // version from the key's base58check prefix and pass it explicitly.
  const raw = base58check(sha256).decode(xpub);
  const versionInt =
    (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3];
  const account = HDKey.fromExtendedKey(xpub, {
    private: 0,
    public: versionInt >>> 0,
  });
  // Standard external receive chain: m/0/i.
  cachedExternal = account.deriveChild(0);
  return cachedExternal;
}

function deriveAddressReal(index: number): string {
  const ext = externalChain()!;
  const child = ext.deriveChild(index);
  if (!child.publicKey) throw new Error("BIP32 child has no public key");
  return p2wpkhAddress(child.publicKey);
}

/** Stub fallback when no xpub is configured (local dev only). */
function deriveAddressStub(index: number): string {
  const h = createHash("sha256")
    .update(`txc-video-wallet-stub:${index}`)
    .digest();
  const payload = new Uint8Array(21);
  payload[0] = TXC_P2PKH_VERSION & 0xff;
  payload.set(h.subarray(0, 20), 1);
  return base58check(sha256).encode(payload);
}

function deriveAddress(index: number): string {
  return process.env.TXC_XPUB ? deriveAddressReal(index) : deriveAddressStub(index);
}

export interface VideoWalletAssignment {
  address: string;
  derivationIndex: number;
}

/**
 * Reserve the next derivation index from the sequence and derive its
 * address. Returns both so the caller can persist them on the video row.
 */
export async function assignVideoWallet(): Promise<VideoWalletAssignment> {
  const { data, error } = await supabaseAdmin.rpc("next_video_wallet_index");
  if (error || data == null) {
    throw new Error(
      `assignVideoWallet failed: ${error?.message ?? "no value returned"}`,
    );
  }
  const next = Number(data);
  return { address: deriveAddress(next), derivationIndex: next };
}

/** Mempool address page — public lifecycle history of a video. */
export function explorerAddressUrl(address: string): string {
  const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";
  return `${base}/address/${address}`;
}