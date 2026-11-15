import { createFileRoute } from "@tanstack/react-router";
import { secretMatches } from "@/lib/admin-token";

/**
 * Cron reconciler for live-stream archives. Picks up `live_streams` rows in
 * `archive_status='transcoding'`, checks the MediaConvert job, and on
 * COMPLETE:
 *   1) starts an asynchronous IPFS pin (Lambda),
 *   2) receives the signed result at ipfs-pin-complete,
 *   3) inserts a normal `videos` row and marks the archive ready there.
 *
 * Auth: `x-admin-token` header must match TXC_RPC_PASS (server-only
 * secret). Same pattern as the other admin/cron endpoints. Using the
 * publishable key here was insecure because that key ships in the
 * browser bundle.
 */
export const Route = createFileRoute("/api/public/hooks/finalize-live-archive")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!secretMatches(provided, expected)) {
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
          .select("id, archive_status, archive_output_prefix, archive_transcode_job_id, updated_at")
          .in("archive_status", ["transcoding", "pinning"])
          .not("archive_transcode_job_id", "is", null)
          .limit(5);
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const results: Array<Record<string, unknown>> = [];
        for (const row of rows ?? []) {
          const jobId = row.archive_transcode_job_id;
          if (!jobId) continue;
          try {
            let status = "COMPLETE";
            if (row.archive_status === "transcoding") {
              const job = (await describeJob(jobId)).job;
              status = job?.status ?? "UNKNOWN";

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
            } else {
              const pinStartedAt = Date.parse(row.updated_at);
              if (Number.isFinite(pinStartedAt) && Date.now() - pinStartedAt < 10 * 60 * 1000) {
                results.push({ id: row.id, action: "pin-in-flight" });
                continue;
              }
            }

            const prefix = row.archive_output_prefix
              ? row.archive_output_prefix.replace(`s3://${outputBucket}/`, "")
              : `hls/live-${row.id}/`;
            const { listObjects } = await import("@/lib/aws-s3.server");
            const keys = await listObjects(outputBucket, prefix);
            if (keys.length === 0) {
              throw new Error(`No HLS outputs under s3://${outputBucket}/${prefix}`);
            }

            const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
            if (!lambdaToken) throw new Error("IPFS_LAMBDA_TOKEN required");
            const fnName = process.env.IPFS_LAMBDA_NAME;
            const callbackSecret = process.env.MEDIACONVERT_WEBHOOK_SECRET;
            if (!fnName) throw new Error("IPFS_LAMBDA_NAME required for async archive pin");
            if (!callbackSecret) throw new Error("MEDIACONVERT_WEBHOOK_SECRET required");

            const callbackUrl = `${new URL(request.url).origin}/api/public/hooks/ipfs-pin-complete`;
            const { invokeLambdaAsync } = await import("@/lib/aws-lambda.server");
            await invokeLambdaAsync(fnName, {
              routeKey: "POST /pin",
              headers: { authorization: `Bearer ${lambdaToken}` },
              body: JSON.stringify({
                bucket: outputBucket,
                keys,
                callbackUrl,
                callbackSecret,
                callbackMeta: { liveStreamId: row.id, jobId, prefix },
              }),
            });

            const { error: updateError } = await supabaseAdmin
              .from("live_streams")
              .update({
                archive_status: "pinning",
                archive_error: null,
              })
              .eq("id", row.id);
            if (updateError) throw new Error(updateError.message);

            results.push({ id: row.id, action: "pin-started", keys: keys.length });
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