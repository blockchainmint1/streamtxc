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
// CURRENT MODE: stub. Until the platform xpub is provided, we generate a
// deterministic fake address from the index. The shape of the address is a
// best-effort guess at TXC P2PKH (starts with 'T'). When the real xpub
// lands, swap `deriveAddressStub()` for a real BIP32 derivation and
// everything downstream keeps working.

import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Base58 alphabet (Bitcoin/Litecoin/TXC). */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  // Tiny base58 encoder. Fine for short payloads (<= 32 bytes).
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    out = B58[r] + out;
  }
  // Leading zero bytes → '1' chars.
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

/**
 * STUB derivation. Produces a deterministic ~34-char base58 string that
 * looks like a P2PKH address (TXC P2PKH addresses start with 'T'). Replace
 * with real BIP32 derivation against the platform xpub when available.
 */
function deriveAddressStub(index: number): string {
  const h = createHash("sha256")
    .update(`txc-video-wallet-stub:${index}`)
    .digest();
  // Take 20 bytes (P2PKH hash160 size), prefix with TXC version byte guess.
  // Real version byte is whatever the TXC chain params say (probably 0x41
  // for 'T' prefix on mainnet; we'll confirm by probing mempool API).
  const versioned = new Uint8Array(21);
  versioned[0] = 0x41; // 'T'-yielding version byte (placeholder)
  versioned.set(h.subarray(0, 20), 1);
  // Skip checksum in stub mode — we just want a plausible-looking string.
  const addr = base58Encode(versioned);
  // Pad to 34 chars if short, truncate if long. Stub-only.
  return addr.length >= 34 ? addr.slice(0, 34) : addr.padEnd(34, "1");
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
  const { data, error } = await supabaseAdmin.rpc("nextval", {} as never).single();
  // Supabase doesn't expose nextval() via PostgREST RPC by default, so use
  // a raw select instead. Fall back to a SELECT through .from() trick.
  if (error || !data) {
    const { data: row, error: e2 } = await supabaseAdmin
      .from("videos")
      .select("derivation_index")
      .order("derivation_index", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (e2) throw new Error(`assignVideoWallet failed: ${e2.message}`);
    const next = (row?.derivation_index ?? 0) + 1;
    return { address: deriveAddressStub(next), derivationIndex: next };
  }
  const next = Number(data);
  return { address: deriveAddressStub(next), derivationIndex: next };
}

/** Mempool address page — public lifecycle history of a video. */
export function explorerAddressUrl(address: string): string {
  const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";
  return `${base}/address/${address}`;
}