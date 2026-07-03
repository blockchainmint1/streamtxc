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

        const { listObjects, getObjectBlob, copyObject } = await import("@/lib/aws-s3.server");

        const prefix = `hls/${cid}/`;
        console.log(`[mediaconvert ${cid}] job ${jobId} COMPLETE — listing HLS outputs from s3://${outputBucket}/${prefix}`);
        let keys = await listObjects(outputBucket, prefix);
        console.log(`[mediaconvert ${cid}] transcode finished — ${keys.length} output objects, starting IPFS pin`);
        if (keys.length === 0) {
          return new Response("No outputs found", { status: 500 });
        }

        // Bundle the original input file inside the HLS pin so the wrap
        // directory contains BOTH `original.<ext>` and the HLS ladder
        // under a single CID. Copy the input object into the output
        // bucket so the Lambda's single-bucket /pin can grab everything.
        const inputBucket = process.env.AWS_S3_INPUT_BUCKET;
        const originalSrcKey = `inputs/${cid}`;
        const originalDstKey = `${prefix}original`;
        let originalIncluded = false;
        if (inputBucket) {
          try {
            await copyObject({
              srcBucket: inputBucket,
              srcKey: originalSrcKey,
              dstBucket: outputBucket,
              dstKey: originalDstKey,
            });
            keys = [originalDstKey, ...keys.filter((k) => k !== originalDstKey)];
            originalIncluded = true;
          } catch (err) {
            console.warn(`hls-pin: failed to copy original ${originalSrcKey} → ${originalDstKey}:`, err);
          }
        }

        // Derive a minimal rendition manifest from the keys we saw.
        const { renditionsFromKeys, finalizeHlsPin } = await import("@/lib/finalize-hls-pin.server");
        const renditions = renditionsFromKeys(keys, prefix);

        if (dryRun) {
          // Test path: don't pin to IPFS, don't touch the DB. Just report
          // what we found so /s3-test can verify the pipeline end-to-end.
          return new Response(
            JSON.stringify({ dryRun: true, cid, jobId, keys, renditions, originalIncluded }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        // Prefer the self-hosted IPFS Lambda via direct AWS Invoke
        // (bypasses the 30s API Gateway HTTP API timeout). Fall back to
        // direct Pinata directory pin when the Lambda isn't reachable.
        let pinnedCid: string;
        let pinnedSize = 0;
        const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
        const lambdaUrl = process.env.IPFS_LAMBDA_URL;
        const lambdaName = process.env.IPFS_LAMBDA_NAME;
        const pinT0 = Date.now();
        if (lambdaToken && (lambdaName || lambdaUrl)) {
          try {
            console.log(`[mediaconvert ${cid}] pinning ${keys.length} files to self-hosted IPFS (ipfs.honest.money) via Lambda`);
            const { callPinLambda } = await import("@/lib/ipfs-lambda.functions");
            const json = await callPinLambda(
              { bucket: outputBucket, keys },
              lambdaToken,
            );
            if (!json.cid) throw new Error("Lambda /pin returned no cid");
            pinnedCid = json.cid;
            pinnedSize = json.totalBytes ?? 0;
          } catch (err) {
            console.warn(`hls-pin: lambda /pin failed (${err instanceof Error ? err.message : err}) — falling back to Pinata`);
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
        } else {
          console.log(`[mediaconvert ${cid}] pinning ${keys.length} files to Pinata (self-hosted Lambda not configured)`);
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
        console.log(`[mediaconvert ${cid}] IPFS pin complete in ${Date.now() - pinT0}ms → ${pinned.cid} (${pinned.size} bytes)`);

        const finalized = await finalizeHlsPin({
          cid, jobId, hlsCid: pinned.cid, renditions,
        });

        // Pinata backup: best-effort mirror of the HLS wrap CID. Never throws.
        const { pinByCid } = await import("@/lib/pinata.server");
        pinByCid(pinned.cid, `hls-${cid}`).catch((e) =>
          console.warn(`[mediaconvert ${cid}] pinata backup failed:`, e),
        );

        // For Zoom imports: transcribe the audio-only MediaConvert output
        // and stamp the transcript CID onto the row. Best-effort —
        // failures don't block the HLS flow.
        let transcript: { cid: string; bytes: number } | null = null;
        try {
          const { maybeTranscribeVideo } = await import(
            "@/lib/transcription.server"
          );
          const t = await maybeTranscribeVideo(cid);
          if (t) transcript = { cid: t.transcriptCid, bytes: t.vttBytes };
        } catch (err) {
          console.warn(`[mediaconvert ${cid}] transcription failed:`, err);
        }

        return new Response(
          JSON.stringify({
            pinnedCid: pinned.cid,
            renditions,
            keys: keys.length,
            rowsUpdated: finalized.rowsUpdated,
            metadataCid: finalized.metadataCid,
            metadataTx: finalized.metadataTx,
            transcriptCid: transcript?.cid ?? null,
            transcriptBytes: transcript?.bytes ?? null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});