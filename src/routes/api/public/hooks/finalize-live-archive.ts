import { createFileRoute } from "@tanstack/react-router";

/**
 * Cron reconciler for live-stream archives. Picks up `live_streams` rows in
 * `archive_status='transcoding'`, checks the MediaConvert job, and on
 * COMPLETE:
 *   1) pins the HLS output directory to IPFS (Lambda),
 *   2) inserts a normal `videos` row (owner = stream.owner_wallet),
 *   3) marks the stream `archive_status='ready'` + stores the resulting cid.
 *
 * Auth: shared with the other pg_cron hooks — Supabase publishable key in
 * the `apikey` header.
 */
export const Route = createFileRoute("/api/public/hooks/finalize-live-archive")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        const provided = request.headers.get("apikey");
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
        if (!outputBucket) {
          return Response.json({ ok: false, error: "AWS_S3_OUTPUT_BUCKET not set" }, { status: 500 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { describeJob } = await import("@/lib/aws-mediaconvert.server");

        const { data: rows, error } = await supabaseAdmin
          .from("live_streams")
          .select("id, title, owner_wallet, thumbnail_cid, archive_transcode_job_id")
          .eq("archive_status", "transcoding")
          .not("archive_transcode_job_id", "is", null)
          .limit(5);
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const results: Array<Record<string, unknown>> = [];
        for (const row of rows ?? []) {
          const jobId = row.archive_transcode_job_id!;
          try {
            const job = (await describeJob(jobId)).job;
            const status = job?.status ?? "UNKNOWN";

            if (status === "ERROR" || status === "CANCELED") {
              await supabaseAdmin
                .from("live_streams")
                .update({
                  archive_status: "failed",
                  archive_error: job?.errorMessage ?? `MediaConvert ${status}`,
                })
                .eq("id", row.id);
              results.push({ id: row.id, action: "marked-failed", status });
              continue;
            }

            if (status !== "COMPLETE") {
              results.push({ id: row.id, action: "still-transcoding", status });
              continue;
            }

            // COMPLETE → pin the HLS output to IPFS.
            await supabaseAdmin
              .from("live_streams")
              .update({ archive_status: "pinning" })
              .eq("id", row.id);

            const prefix = `hls/live-${row.id}/`;
            const { listObjects } = await import("@/lib/aws-s3.server");
            const keys = await listObjects(outputBucket, prefix);
            if (keys.length === 0) {
              throw new Error(`No HLS outputs under s3://${outputBucket}/${prefix}`);
            }

            const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
            if (!lambdaToken) throw new Error("IPFS_LAMBDA_TOKEN required");
            const { callPinLambda } = await import("@/lib/ipfs-lambda.functions");
            const pinned = await callPinLambda(
              { bucket: outputBucket, keys },
              lambdaToken,
            );
            if (!pinned.cid) throw new Error("Lambda /pin returned no cid");

            const cid = pinned.cid;
            const totalBytes = pinned.totalBytes ?? 0;

            // Insert a normal videos row for the archive. It gets a
            // standard 7-day grace window; the owner extends it from
            // /manage like any other upload.
            const { renditionsFromKeys } = await import("@/lib/finalize-hls-pin.server");
            const renditions = renditionsFromKeys(keys, prefix);
            const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

            const { error: vErr } = await supabaseAdmin.from("videos").insert({
              cid,
              owner_wallet: row.owner_wallet,
              title: row.title,
              size_bytes: totalBytes,
              mime_type: "application/vnd.apple.mpegurl",
              status: "ready",
              months_prepaid: 0,
              expires_at: expires,
              hls_cid: cid,
              renditions,
              transcode_status: "ready",
              transcode_job_id: jobId,
              transcode_completed_at: new Date().toISOString(),
              thumbnail_cid: row.thumbnail_cid ?? null,
              source: "live-archive",
            });
            if (vErr && vErr.code !== "23505") {
              // 23505 = duplicate cid; treat as idempotent success.
              throw new Error(`videos insert failed: ${vErr.message}`);
            }

            await supabaseAdmin
              .from("live_streams")
              .update({
                archive_status: "ready",
                archive_video_cid: cid,
                archive_error: null,
              })
              .eq("id", row.id);

            results.push({ id: row.id, action: "archived", cid, keys: keys.length });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await supabaseAdmin
              .from("live_streams")
              .update({ archive_status: "failed", archive_error: msg })
              .eq("id", row.id);
            results.push({ id: row.id, action: "failed", error: msg });
          }
        }

        return Response.json({ ok: true, considered: rows?.length ?? 0, results });
      },
    },
  },
});