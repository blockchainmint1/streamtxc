import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Callback webhook posted by the IPFS pinning Lambda when an async HLS
 * bundle pin completes. The Lambda signs the JSON body with HMAC-SHA256
 * using the same secret we passed in the invoke payload (reusing
 * MEDIACONVERT_WEBHOOK_SECRET so there is only one shared HMAC secret
 * to manage). Body shape (from lambda/index.js):
 *   {
 *     cid:       string | null,   // pinned wrap-directory CID, null on error
 *     files:     number,
 *     totalBytes:number,
 *     manifest:  Array<{path,cid,size}>,
 *     error:     string | null,
 *     meta:      { cid?: string, liveStreamId?: string, jobId: string, prefix: string }
 *   }
 */
export const Route = createFileRoute("/api/public/hooks/ipfs-pin-complete")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.MEDIACONVERT_WEBHOOK_SECRET;
        if (!secret) return new Response("Webhook not configured", { status: 503 });

        const body = await request.text();
        const sig = request.headers.get("x-webhook-signature") ?? "";
        const expected = createHmac("sha256", secret).update(body).digest("hex");
        if (
          sig.length !== expected.length ||
          !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
        ) {
          return new Response("Invalid signature", { status: 401 });
        }

        let event: {
          cid?: string | null;
          totalBytes?: number;
          error?: string | null;
          meta?: { cid?: string; liveStreamId?: string; jobId?: string; prefix?: string };
        };
        try { event = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }

        const videoCid = event.meta?.cid;
        const liveStreamId = event.meta?.liveStreamId;
        const jobId = event.meta?.jobId;
        const prefix = event.meta?.prefix;
        if ((!videoCid && !liveStreamId) || !jobId || !prefix) {
          return new Response("Missing meta", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if (liveStreamId) {
          if (event.error || !event.cid) {
            await supabaseAdmin
              .from("live_streams")
              .update({ archive_status: "failed", archive_error: event.error ?? "IPFS pin failed" })
              .eq("id", liveStreamId)
              .eq("archive_transcode_job_id", jobId);
            return Response.json({ ok: false, error: event.error ?? "pin failed" });
          }

          const { data: stream, error: streamError } = await supabaseAdmin
            .from("live_streams")
            .select("id, title, owner_wallet, thumbnail_cid")
            .eq("id", liveStreamId)
            .eq("archive_transcode_job_id", jobId)
            .maybeSingle();
          if (streamError) throw new Error(streamError.message);
          if (!stream) return new Response("Archive not found", { status: 404 });

          const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
          if (!outputBucket) return new Response("S3 not configured", { status: 503 });
          const { listObjects } = await import("@/lib/aws-s3.server");
          const keys = await listObjects(outputBucket, prefix);
          const { renditionsFromKeys } = await import("@/lib/finalize-hls-pin.server");
          const renditions = renditionsFromKeys(keys, prefix);
          const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

          // Live archives had no poster image: MediaConvert now writes a
          // frame capture next to the HLS bundle (thumbs/…). Pin the first
          // JPEG so archived streams show a thumbnail like normal uploads.
          let thumbnailCid = stream.thumbnail_cid ?? null;
          if (!thumbnailCid) {
            try {
              const thumbPrefix = prefix.replace(/^hls\//, "thumbs/");
              const thumbKeys = (await listObjects(outputBucket, thumbPrefix))
                .filter((k) => /\.jpe?g$/i.test(k))
                .sort();
              const pick = thumbKeys[Math.min(1, thumbKeys.length - 1)];
              if (pick) {
                const { getObjectBlob } = await import("@/lib/aws-s3.server");
                const { pinFileToIPFS } = await import("@/lib/ipfs.server");
                const blob = await getObjectBlob(outputBucket, pick);
                const pinnedThumb = await pinFileToIPFS(blob, "thumb.jpg");
                thumbnailCid = pinnedThumb.cid;
                await supabaseAdmin
                  .from("live_streams")
                  .update({ thumbnail_cid: thumbnailCid })
                  .eq("id", liveStreamId);
              }
            } catch (err) {
              console.warn(`[ipfs-pin-complete ${liveStreamId}] thumbnail capture failed`, err);
            }
          }

          // Live archives are first-class videos: give them a per-video TXC
          // wallet and stamp the claim (C) + metadata (T) anchors, exactly
          // like a normal upload. Without this the on-chain proof panel
          // spins on "pending — in mempool" forever.
          const { assignVideoWallet } = await import("@/lib/txc-wallets.server");
          const { recordChainEvent, recordMetadataAnchor } = await import(
            "@/lib/chain-events.server"
          );
          const uploaderWallet = stream.owner_wallet ?? "anon";
          const videoWallet = await assignVideoWallet();
          const stamp = await recordChainEvent({
            cid: event.cid,
            videoWallet: videoWallet.address,
            eventType: "C",
            uploaderWallet,
          });
          const meta = await recordMetadataAnchor({
            videoCid: event.cid,
            videoWallet: videoWallet.address,
            uploaderWallet,
            title: stream.title ?? "",
            description: "",
            thumbnailCid: thumbnailCid,
            hlsCid: event.cid,
            renditions,
          });

          const { error: videoError } = await supabaseAdmin.from("videos").insert({
            cid: event.cid,
            owner_wallet: stream.owner_wallet,
            title: stream.title,
            size_bytes: event.totalBytes ?? 0,
            mime_type: "application/vnd.apple.mpegurl",
            status: "active",
            months_prepaid: 0,
            expires_at: expiresAt,
            hls_cid: event.cid,
            renditions,
            transcode_status: "ready",
            transcode_job_id: jobId,
            transcode_completed_at: new Date().toISOString(),
            thumbnail_cid: thumbnailCid,
            source: "live-archive",
            live_stream_id: liveStreamId,
            video_wallet: videoWallet.address,
            derivation_index: videoWallet.derivationIndex,
            tx_hash: stamp.real ? stamp.txid : null,
            op_return_payload: stamp.payload,
            metadata_cid: meta?.metaCid ?? null,
          });

          if (videoError && videoError.code !== "23505") {
            throw new Error(`videos insert failed: ${videoError.message}`);
          }
          if (!videoError) {
            const { fileVideoInOwnerBranch } = await import("@/lib/owner-branch.server");
            await fileVideoInOwnerBranch({ cid: event.cid, ownerWallet: stream.owner_wallet });
          }

          const { error: archiveError } = await supabaseAdmin
            .from("live_streams")
            .update({ archive_status: "ready", archive_video_cid: event.cid, archive_error: null })
            .eq("id", liveStreamId)
            .eq("archive_transcode_job_id", jobId);
          if (archiveError) throw new Error(archiveError.message);

          return Response.json({ ok: true, liveStreamId, cid: event.cid });
        }

        if (!videoCid) return new Response("Missing video cid", { status: 400 });

        // Lambda reported a pin failure — mark the row failed so the UI stops spinning.
        if (event.error || !event.cid) {
          await supabaseAdmin
            .from("videos")
            .update({
              transcode_status: "failed",
              transcode_error: event.error ?? "IPFS pin failed",
              transcode_completed_at: new Date().toISOString(),
            })
            .eq("cid", videoCid)
            .eq("transcode_job_id", jobId);
          return Response.json({ ok: false, error: event.error ?? "pin failed" }, { status: 200 });
        }

        // Pin succeeded — derive renditions from the S3 listing and finalize.
        const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
        if (!outputBucket) return new Response("S3 not configured", { status: 503 });
        const { listObjects } = await import("@/lib/aws-s3.server");
        const keys = await listObjects(outputBucket, prefix);
        const { finalizeHlsPin, renditionsFromKeys } = await import("@/lib/finalize-hls-pin.server");
        const renditions = renditionsFromKeys(keys, prefix);
        const result = await finalizeHlsPin({
          cid: videoCid, jobId, hlsCid: event.cid, renditions,
        });
        console.log(`[ipfs-pin-complete ${videoCid}] hls cid ${event.cid} · rows ${result.rowsUpdated}`);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});