// Per-video TXC wallet assignment (server-only).
//
// ARCHITECTURE — node-managed wallets
// Every video / comment / boost gets its own TXC deposit address minted
// directly by the platform's hot wallet via JSON-RPC `getnewaddress`.
// The node owns the private key, so:
//   - we never ship a `xpub` or `xprv` in env
//   - sweeps of received funds (90/5/5 splits) are atomic `sendmany` /
//     `sendtoaddress` calls — no separate signer required
//
// We still pull a monotonic index from `next_video_wallet_index` and use
// it as the wallet label (`video-wallet:<index>`). That gives every
// address a stable, traceable name on the node side and keeps the
// `derivation_index` column populated for back-compat.
//
// Every on-chain lifecycle event for a video — claim, payment, renewal,
// takedown, DMCA — is still sent TO this address, so
// mempool.texitcoin.org/address/<addr> shows the video's complete public
// history.

import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getNewLabeledAddress } from "./txc.server";

function rpcConfigured(): boolean {
  return !!(
    process.env.TXC_RPC_URL &&
    process.env.TXC_RPC_USER &&
    process.env.TXC_RPC_PASS
  );
}

/**
 * Local-dev fallback so the app boots without a node configured. NEVER
 * receives real funds — purely a placeholder string in the DB row.
 */
function stubAddress(index: number): string {
  const h = createHash("sha256")
    .update(`txc-video-wallet-stub:${index}`)
    .digest("hex")
    .slice(0, 32);
  return `txc1qstub${index}${h}`.slice(0, 50);
}

export interface VideoWalletAssignment {
  address: string;
  derivationIndex: number;
}

/**
 * Reserve the next index from the sequence and ask the node to mint a
 * fresh wallet-owned address labeled `video-wallet:<index>`.
 */
export async function assignVideoWallet(): Promise<VideoWalletAssignment> {
  const { data, error } = await supabaseAdmin.rpc("next_video_wallet_index");
  if (error || data == null) {
    throw new Error(
      `assignVideoWallet failed: ${error?.message ?? "no value returned"}`,
    );
  }
  const next = Number(data);
  if (!rpcConfigured()) {
    return { address: stubAddress(next), derivationIndex: next };
  }
  const address = await getNewLabeledAddress(`video-wallet:${next}`);
  return { address, derivationIndex: next };
}

/** Mempool address page — public lifecycle history of a video. */
export function explorerAddressUrl(address: string): string {
  const base = process.env.TXC_MEMPOOL_URL || "https://mempool.texitcoin.org";
  return `${base}/address/${address}`;
}