import { createFileRoute } from "@tanstack/react-router";

/**
 * Admin endpoint: restart MediaConvert transcoding for a video whose
 * input is already in S3 at `inputs/<cid>`. Resets the DB row and kicks
 * off a fresh job. Guarded by `x-admin-token` = TXC_RPC_PASS.
 *
 *   POST /api/public/admin/retry-transcode?cid=<videoCid>
 *   POST /api/public/admin/retry-transcode?cid=a,b,c   (comma list)
 */
export const Route = createFileRoute("/api/public/admin/retry-transcode")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        const url = new URL(request.url);
        const cidParam = url.searchParams.get("cid");
        if (!cidParam) {
          return Response.json({ ok: false, error: "missing ?cid" }, { status: 400 });
        }
        const cids = cidParam.split(",").map((s) => s.trim()).filter(Boolean);

        const inputBucket = process.env.AWS_S3_INPUT_BUCKET;
        const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
        if (!inputBucket || !outputBucket) {
          return Response.json({ ok: false, error: "AWS buckets not set" }, { status: 500 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { startHlsTranscode } = await import("@/lib/aws-mediaconvert.server");

        const results: Array<Record<string, unknown>> = [];
        for (const cid of cids) {
          try {
            const { data: video, error: vErr } = await supabaseAdmin
              .from("videos")
              .select("cid")
              .eq("cid", cid)
              .maybeSingle();
            if (vErr) throw vErr;
            if (!video) {
              results.push({ cid, ok: false, error: "not found" });
              continue;
            }

            const { jobId } = await startHlsTranscode({
              inputUri: `s3://${inputBucket}/inputs/${cid}`,
              outputPrefix: `s3://${outputBucket}/hls/${cid}/`,
              videoId: cid,
            });

            await supabaseAdmin
              .from("videos")
              .update({
                transcode_status: "processing",
                transcode_job_id: jobId,
                transcode_started_at: new Date().toISOString(),
                transcode_completed_at: null,
                transcode_error: null,
              })
              .eq("cid", cid);

            results.push({ cid, ok: true, jobId });
          } catch (err) {
            results.push({
              cid,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return Response.json({ ok: true, results });
      },
    },
  },
});