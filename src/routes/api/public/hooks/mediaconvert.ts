import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * MediaConvert completion webhook (delivered by EventBridge → API Destination).
 *
 * Expected event shape (CloudWatch / EventBridge "MediaConvert Job State Change"):
 *   { detail: { jobId, status: 'COMPLETE'|'ERROR'|..., userMetadata: { videoId } } }
 *
 * On COMPLETE: list HLS outputs in S3, pin them to Pinata as one directory,
 * write the directory CID + rendition manifest back to the videos row, and
 * re-stamp metadata to chain so the new CIDs are anchored.
 *
 * Auth: HMAC-SHA256 over the raw body, signed with MEDIACONVERT_WEBHOOK_SECRET,
 * supplied in `x-webhook-signature`. EventBridge API Destinations support
 * static auth headers and connection secrets — easiest setup is a custom
 * connection header with the precomputed shared secret.
 */
export const Route = createFileRoute("/api/public/hooks/mediaconvert")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.MEDIACONVERT_WEBHOOK_SECRET;
        if (!secret) return new Response("Webhook not configured", { status: 503 });

        const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
        const body = await request.text();
        const sig = request.headers.get("x-webhook-signature") ?? "";
        const expected = createHmac("sha256", secret).update(body).digest("hex");
        if (
          sig.length !== expected.length ||
          !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
        ) {
          return new Response("Invalid signature", { status: 401 });
        }

        type Event = {
          detail?: {
            jobId?: string;
            status?: string;
            errorMessage?: string;
            userMetadata?: { videoId?: string };
            outputGroupDetails?: Array<{ playlistFilePaths?: string[] }>;
          };
        };
        let event: Event;
        try {
          event = JSON.parse(body);
        } catch {
          return new Response("Bad JSON", { status: 400 });
        }

        const detail = event.detail ?? {};
        const cid = detail.userMetadata?.videoId; // we round-trip cid as videoId
        const jobId = detail.jobId;
        const status = detail.status;
        if (!cid || !jobId || !status) {
          return new Response("Missing fields", { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        if (status !== "COMPLETE") {
          await supabaseAdmin
            .from("videos")
            .update({
              transcode_status: status === "ERROR" ? "failed" : status.toLowerCase(),
              transcode_error: detail.errorMessage ?? null,
              transcode_completed_at: new Date().toISOString(),
            })
            .eq("cid", cid)
            .eq("transcode_job_id", jobId);
          return new Response("ok");
        }

        // COMPLETE — pull all output files from S3 and pin them as one directory.
        const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
        if (!outputBucket) return new Response("S3 not configured", { status: 503 });

        const { listObjects, getObjectBlob } = await import("@/lib/aws-s3.server");

        const prefix = `hls/${cid}/`;
        const keys = await listObjects(outputBucket, prefix);
        if (keys.length === 0) {
          return new Response("No outputs found", { status: 500 });
        }

        // Derive a minimal rendition manifest from the keys we saw.
        const renditions = keys
          .filter((k) => k.endsWith(".m3u8") && !k.endsWith("/master.m3u8"))
          .map((k) => {
            const rel = k.slice(prefix.length);
            const m = rel.match(/(\d+)p/);
            return {
              height: m ? Number(m[1]) : null,
              playlist: rel,
            };
          });

        if (dryRun) {
          // Test path: don't pin to IPFS, don't touch the DB. Just report
          // what we found so /s3-test can verify the pipeline end-to-end.
          return new Response(
            JSON.stringify({ dryRun: true, cid, jobId, keys, renditions }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        // Prefer the self-hosted IPFS Lambda (streams S3 → kubo node, no
        // Worker memory pressure). Fall back to direct Pinata directory
        // pin when the Lambda isn't configured or fails.
        let pinnedCid: string;
        let pinnedSize = 0;
        const lambdaUrl = process.env.IPFS_LAMBDA_URL;
        const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
        if (lambdaUrl && lambdaToken) {
          const res = await fetch(`${lambdaUrl.replace(/\/$/, "")}/pin`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${lambdaToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ bucket: outputBucket, prefix }),
          });
          const text = await res.text();
          if (!res.ok) {
            console.warn(`hls-pin: lambda /pin failed [${res.status}]: ${text.slice(0, 400)} — falling back to Pinata`);
            const { pinDirectoryToIPFS } = await import("@/lib/pinata.server");
            const files: Array<{ path: string; body: Blob; contentType?: string }> = [];
            for (const key of keys) {
              const blob = await getObjectBlob(outputBucket, key);
              files.push({
                path: key.slice(prefix.length),
                body: blob,
                contentType: blob.type || undefined,
              });
            }
            const fb = await pinDirectoryToIPFS(files, `hls-${cid}`);
            pinnedCid = fb.cid;
            pinnedSize = fb.size;
          } else {
            const json = JSON.parse(text) as { cid: string; totalBytes?: number };
            pinnedCid = json.cid;
            pinnedSize = json.totalBytes ?? 0;
          }
        } else {
          const { pinDirectoryToIPFS } = await import("@/lib/pinata.server");
          const files: Array<{ path: string; body: Blob; contentType?: string }> = [];
          for (const key of keys) {
            const blob = await getObjectBlob(outputBucket, key);
            files.push({
              path: key.slice(prefix.length),
              body: blob,
              contentType: blob.type || undefined,
            });
          }
          const fb = await pinDirectoryToIPFS(files, `hls-${cid}`);
          pinnedCid = fb.cid;
          pinnedSize = fb.size;
        }
        const pinned = { cid: pinnedCid, size: pinnedSize };

        // Look up the videos row so we can re-anchor full metadata (v3
        // adds hlsCid + renditions) to IPFS and the chain. Best-effort —
        // if the row doesn't exist (e.g. /s3-test), skip re-anchor.
        const { data: row } = await supabaseAdmin
          .from("videos")
          .select("video_wallet, owner_wallet, title, description, thumbnail_cid")
          .eq("cid", cid)
          .maybeSingle();

        let newMetaCid: string | null = null;
        let newMetaTx: string | null = null;
        if (row && row.video_wallet && row.owner_wallet) {
          const { recordMetadataAnchor } = await import("@/lib/chain-events.server");
          const anchored = await recordMetadataAnchor({
            videoCid: cid,
            videoWallet: row.video_wallet,
            uploaderWallet: row.owner_wallet,
            title: row.title ?? "",
            description: row.description ?? "",
            thumbnailCid: row.thumbnail_cid ?? null,
            hlsCid: pinned.cid,
            renditions,
          });
          if (anchored) {
            newMetaCid = anchored.metaCid;
            newMetaTx = anchored.stamp.real ? anchored.stamp.txid : null;
          }
        }

        const { error: updErr, count } = await supabaseAdmin
          .from("videos")
          .update({
            hls_cid: pinned.cid,
            renditions,
            transcode_status: "ready",
            transcode_completed_at: new Date().toISOString(),
            transcode_error: null,
            ...(newMetaCid ? { metadata_cid: newMetaCid } : {}),
            ...(newMetaTx ? { tx_hash: newMetaTx } : {}),
          }, { count: "exact" })
          .eq("cid", cid)
          .eq("transcode_job_id", jobId);
        if (updErr) {
          return new Response(
            JSON.stringify({ pinnedCid: pinned.cid, dbError: updErr.message }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }

        // Note: re-stamping the chain with the new hls_cid is intentionally
        // a follow-up task (Phase 4b). The existing stamp pipeline anchors a
        // single CID per video, so we'll extend the payload schema before
        // calling it from here. For now the new hls_cid lives in the videos
        // row and powers playback; the chain still anchors the original CID.

        return new Response(
          JSON.stringify({
            pinnedCid: pinned.cid,
            renditions,
            keys: keys.length,
            rowsUpdated: count ?? 0,
            metadataCid: newMetaCid,
            metadataTx: newMetaTx,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});