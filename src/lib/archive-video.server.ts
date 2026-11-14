// Turns a pinned HLS bundle (from MediaConvert → IPFS Lambda) into a normal
// channel video: poster frame, per-video TXC wallet, claim + metadata anchors,
// videos row, and filing in the owner's HME Wallet branch.
// Used by published meeting recordings (live archives keep their own copy in
// ipfs-pin-complete).

export async function createChannelVideoFromPin(args: {
  hlsCid: string;
  totalBytes: number;
  jobId: string;
  prefix: string;
  ownerWallet: string;
  title: string;
  description: string;
  transcriptText: string | null;
  source: string;
}): Promise<{ inserted: boolean }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
  if (!outputBucket) throw new Error("S3 not configured");
  const { listObjects, getObjectBlob } = await import("./aws-s3.server");
  const keys = await listObjects(outputBucket, args.prefix);
  const { renditionsFromKeys } = await import("./finalize-hls-pin.server");
  const renditions = renditionsFromKeys(keys, args.prefix);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  let thumbnailCid: string | null = null;
  try {
    const thumbPrefix = args.prefix.replace(/^hls\//, "thumbs/");
    const thumbKeys = (await listObjects(outputBucket, thumbPrefix)).filter((k) => /\.jpe?g$/i.test(k)).sort();
    const pick = thumbKeys[Math.min(1, thumbKeys.length - 1)];
    if (pick) {
      const { pinFileToIPFS } = await import("./ipfs.server");
      thumbnailCid = (await pinFileToIPFS(await getObjectBlob(outputBucket, pick), "thumb.jpg")).cid;
    }
  } catch (err) {
    console.warn(`[channel-video ${args.hlsCid}] thumbnail capture failed`, err);
  }

  const { assignVideoWallet } = await import("./txc-wallets.server");
  const { recordChainEvent, recordMetadataAnchor } = await import("./chain-events.server");
  const videoWallet = await assignVideoWallet();
  const stamp = await recordChainEvent({
    cid: args.hlsCid,
    videoWallet: videoWallet.address,
    eventType: "C",
    uploaderWallet: args.ownerWallet,
  });
  const meta = await recordMetadataAnchor({
    videoCid: args.hlsCid,
    videoWallet: videoWallet.address,
    uploaderWallet: args.ownerWallet,
    title: args.title,
    description: args.description,
    thumbnailCid,
    hlsCid: args.hlsCid,
    renditions,
  });

  const { error } = await (supabaseAdmin as any).from("videos").insert({
    cid: args.hlsCid,
    owner_wallet: args.ownerWallet,
    title: args.title,
    description: args.description || null,
    size_bytes: args.totalBytes,
    mime_type: "application/vnd.apple.mpegurl",
    status: "active",
    months_prepaid: 0,
    expires_at: expiresAt,
    hls_cid: args.hlsCid,
    renditions,
    transcode_status: "ready",
    transcode_job_id: args.jobId,
    transcode_completed_at: new Date().toISOString(),
    thumbnail_cid: thumbnailCid,
    source: args.source,
    transcript_text: args.transcriptText,
    video_wallet: videoWallet.address,
    derivation_index: videoWallet.derivationIndex,
    tx_hash: stamp.real ? stamp.txid : null,
    op_return_payload: stamp.payload,
    metadata_cid: meta?.metaCid ?? null,
  });
  if (error && error.code !== "23505") throw new Error(`videos insert failed: ${error.message}`);
  if (!error) {
    const { fileVideoInOwnerBranch } = await import("./owner-branch.server");
    await fileVideoInOwnerBranch({ cid: args.hlsCid, ownerWallet: args.ownerWallet });
  }
  return { inserted: !error };
}
