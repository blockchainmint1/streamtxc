import { createFileRoute } from "@tanstack/react-router";

/**
 * Cron-driven reconciler for HLS transcodes that finished on MediaConvert
 * but whose EventBridge webhook never reached us (so the row is stuck on
 * transcode_status='processing'). Looks at every row in 'processing' older
 * than ~3 minutes, checks if the S3 output prefix exists, and runs the
 * same finalize-pin pipeline the webhook would have run.
 *
 * Auth: standard pg_cron `apikey` header (Supabase anon/publishable key).
 * The /api/public/* prefix bypasses Lovable's published-site auth, so
 * we require the apikey ourselves to keep the endpoint from being
 * trivially callable.
 */
export const Route = createFileRoute("/api/public/hooks/finalize-stuck-hls")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY;
        const provided = request.headers.get("apikey");
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
        const { retryFinalizePinFromS3 } = await import(
          "@/lib/finalize-hls-pin.server"
        );

        const { data: rows, error } = await supabaseAdmin
          .from("videos")
          .select("cid, transcode_started_at")
          .eq("transcode_status", "processing")
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
            const r = await retryFinalizePinFromS3(row.cid);
            results.push({ cid: row.cid, action: "finalized", ...r });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // "No HLS outputs" just means MediaConvert hasn't finished
            // yet — skip quietly so we don't spam errors.
            if (msg.startsWith("No HLS outputs")) {
              results.push({ cid: row.cid, action: "not-ready" });
            } else {
              results.push({ cid: row.cid, action: "failed", error: msg });
            }
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