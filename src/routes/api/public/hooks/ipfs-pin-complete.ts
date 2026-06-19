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
 *     meta:      { cid: string, jobId: string, prefix: string } // round-tripped from caller
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
          error?: string | null;
          meta?: { cid?: string; jobId?: string; prefix?: string };
        };
        try { event = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }

        const videoCid = event.meta?.cid;
        const jobId = event.meta?.jobId;
        const prefix = event.meta?.prefix;
        if (!videoCid || !jobId || !prefix) return new Response("Missing meta", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

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
        // Self-node primary already succeeded (that's why we're here).
        // Fire-and-forget Pinata backup on the HLS wrap-directory CID so
        // the bundle lives in two places. Never throws.
        const { pinByCid } = await import("@/lib/pinata.server");
        pinByCid(event.cid, `hls-${videoCid}`).catch((e) =>
          console.warn(`[ipfs-pin-complete ${videoCid}] pinata backup failed:`, e),
        );
        console.log(`[ipfs-pin-complete ${videoCid}] hls cid ${event.cid} · rows ${result.rowsUpdated}`);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});