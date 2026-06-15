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

        const pinned = await pinDirectoryToIPFS(files, `hls-${cid}`);

        await supabaseAdmin
          .from("videos")
          .update({
            hls_cid: pinned.cid,
            renditions,
            transcode_status: "ready",
            transcode_completed_at: new Date().toISOString(),
            transcode_error: null,
          })
          .eq("cid", cid)
          .eq("transcode_job_id", jobId);

        // Note: re-stamping the chain with the new hls_cid is intentionally
        // a follow-up task (Phase 4b). The existing stamp pipeline anchors a
        // single CID per video, so we'll extend the payload schema before
        // calling it from here. For now the new hls_cid lives in the videos
        // row and powers playback; the chain still anchors the original CID.

        return new Response("ok");
      },
    },
  },
});