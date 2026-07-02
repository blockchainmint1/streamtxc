import { createFileRoute } from "@tanstack/react-router";

/**
 * Cron-driven reconciler for HLS transcodes that finished on MediaConvert
 * but whose EventBridge webhook never reached us (so the row is stuck on
 * transcode_status='processing'). Looks at every row in 'processing' older
 * than ~3 minutes, checks the real MediaConvert job state, and then queues
 * async IPFS pinning. It does not pin inline because that can exceed request
 * timeouts and leave rows spinning forever.
 *
 * Auth: `x-admin-token` header must match TXC_RPC_PASS (server-only
 * secret). Same pattern as the other admin/cron endpoints. Using the
 * publishable-key here was insecure because that key ships in the
 * browser bundle.
 */
export const Route = createFileRoute("/api/public/hooks/finalize-stuck-hls")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const url = new URL(request.url);
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 1),
          25,
        );
        // Only consider jobs that have had time to finish on MediaConvert.
        const minAgeMin = Math.max(
          parseInt(url.searchParams.get("minAgeMin") ?? "3", 10) || 3,
          1,
        );
        const cutoff = new Date(Date.now() - minAgeMin * 60_000).toISOString();

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { describeJob } = await import("@/lib/aws-mediaconvert.server");
        const { kickHlsPinAsyncForJob } = await import("@/lib/ipfs-lambda.functions");

        const { data: rows, error } = await supabaseAdmin
          .from("videos")
          .select("cid, transcode_job_id, transcode_started_at")
          .eq("transcode_status", "processing")
          .not("transcode_job_id", "is", null)
          .lt("transcode_started_at", cutoff)
          .order("transcode_started_at", { ascending: true })
          .limit(limit);
        if (error) {
          return Response.json(
            { ok: false, error: error.message },
            { status: 500 },
          );
        }

        const results: Array<Record<string, unknown>> = [];
        for (const row of rows ?? []) {
          try {
            const jobId = row.transcode_job_id;
            if (!jobId) {
              results.push({ cid: row.cid, action: "failed", error: "missing job id" });
              continue;
            }

            const job = (await describeJob(jobId)).job;
            const status = job?.status ?? "UNKNOWN";

            if (status === "COMPLETE") {
              const queued = await kickHlsPinAsyncForJob({ cid: row.cid, jobId });
              results.push({ cid: row.cid, action: "pin-queued", ...queued });
              continue;
            }

            if (status === "ERROR" || status === "CANCELED") {
              await supabaseAdmin
                .from("videos")
                .update({
                  transcode_status: "failed",
                  transcode_error: job?.errorMessage ?? `MediaConvert ${status.toLowerCase()}`,
                  transcode_completed_at: new Date().toISOString(),
                })
                .eq("cid", row.cid)
                .eq("transcode_job_id", jobId);
              results.push({ cid: row.cid, action: "marked-failed", status });
              continue;
            }

            results.push({ cid: row.cid, action: "still-processing", status });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ cid: row.cid, action: "failed", error: msg });
          }
        }
        return Response.json({
          ok: true,
          considered: rows?.length ?? 0,
          results,
        });
      },
    },
  },
});