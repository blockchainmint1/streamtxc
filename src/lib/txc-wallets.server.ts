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
import { base58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// TXC P2PKH version byte. 0x41 yields a base58check string starting with
// 'T' for a 20-byte hash160 payload, matching what we see on
// mempool.texitcoin.org. Override via TXC_P2PKH_VERSION if the chain ever
// changes its prefix.
const TXC_P2PKH_VERSION = process.env.TXC_P2PKH_VERSION
  ? Number(process.env.TXC_P2PKH_VERSION)
  : 0x41;

const b58c = base58check(sha256);

function hash160(pub: Uint8Array): Uint8Array {
  return ripemd160(sha256(pub));
}

function pubkeyToAddress(pub: Uint8Array): string {
  const h = hash160(pub);
  const payload = new Uint8Array(1 + h.length);
  payload[0] = TXC_P2PKH_VERSION & 0xff;
  payload.set(h, 1);
  return b58c.encode(payload);
}

let cachedExternal: HDKey | null = null;
function externalChain(): HDKey | null {
  if (cachedExternal) return cachedExternal;
  const xpub = process.env.TXC_XPUB;
  if (!xpub) return null;
  // The xpub the user provides is expected to be an account-level key
  // (m/44'/<coin>'/0'). We derive the external receive chain (/0) from it.
  // If the xpub is already at the external-chain level, m/0 is still safe
  // because the chain index becomes the leaf — addresses would then live at
  // /0/<i>. For account-level (the common case) we get standard /0/<i>.
  const account = HDKey.fromExtendedKey(xpub);
  cachedExternal = account.deriveChild(0);
  return cachedExternal;
}

function deriveAddressReal(index: number): string {
  const ext = externalChain()!;
  const child = ext.deriveChild(index);
  if (!child.publicKey) throw new Error("BIP32 child has no public key");
  return pubkeyToAddress(child.publicKey);
}

/** Stub fallback when no xpub is configured (local dev only). */
function deriveAddressStub(index: number): string {
  const h = createHash("sha256")
    .update(`txc-video-wallet-stub:${index}`)
    .digest();
  const payload = new Uint8Array(21);
  payload[0] = TXC_P2PKH_VERSION & 0xff;
  payload.set(h.subarray(0, 20), 1);
  return b58c.encode(payload);
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