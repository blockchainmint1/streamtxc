// Shared post-pin "finalize" logic used by both the MediaConvert webhook
// (sync path: pin happens inside the webhook) and the IPFS Lambda async
// callback webhook (pin happens in the Lambda, callback hits us with the
// resulting CID). Keeps the chain-anchor + DB-update logic in exactly
// one place.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface FinalizeInput {
  cid: string;
  jobId: string;
  hlsCid: string;
  /** Derived from listing the HLS output bucket prefix. */
  renditions: Array<{ height: number | null; playlist: string }>;
}

export interface FinalizeResult {
  rowsUpdated: number;
  metadataCid: string | null;
  metadataTx: string | null;
}

export async function finalizeHlsPin(input: FinalizeInput): Promise<FinalizeResult> {
  const { data: row } = await supabaseAdmin
    .from("videos")
    .select("video_wallet, owner_wallet, title, description, thumbnail_cid")
    .eq("cid", input.cid)
    .maybeSingle();

  let metadataCid: string | null = null;
  let metadataTx: string | null = null;
  if (row && row.video_wallet && row.owner_wallet) {
    const { recordMetadataAnchor } = await import("./chain-events.server");
    const anchored = await recordMetadataAnchor({
      videoCid: input.cid,
      videoWallet: row.video_wallet,
      uploaderWallet: row.owner_wallet,
      title: row.title ?? "",
      description: row.description ?? "",
      thumbnailCid: row.thumbnail_cid ?? null,
      hlsCid: input.hlsCid,
      renditions: input.renditions,
    });
    if (anchored) {
      metadataCid = anchored.metaCid;
      metadataTx = anchored.stamp.real ? anchored.stamp.txid : null;
    }
  }

  const { count } = await supabaseAdmin
    .from("videos")
    .update({
      hls_cid: input.hlsCid,
      renditions: input.renditions,
      transcode_status: "ready",
      transcode_completed_at: new Date().toISOString(),
      transcode_error: null,
      ...(metadataCid ? { metadata_cid: metadataCid } : {}),
      ...(metadataTx ? { tx_hash: metadataTx } : {}),
    }, { count: "exact" })
    .eq("cid", input.cid)
    .eq("transcode_job_id", input.jobId);

  return { rowsUpdated: count ?? 0, metadataCid, metadataTx };
}

/** Derive renditions list from S3 keys (e.g. `hls/<cid>/720p.m3u8`). */
export function renditionsFromKeys(
  keys: string[],
  prefix: string,
): Array<{ height: number | null; playlist: string }> {
  return keys
    .filter((k) => k.endsWith(".m3u8") && !k.endsWith("/master.m3u8"))
    .map((k) => {
      const rel = k.slice(prefix.length);
      const m = rel.match(/(\d+)p/);
      return { height: m ? Number(m[1]) : null, playlist: rel };
    });
}