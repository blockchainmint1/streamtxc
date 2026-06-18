import { createFileRoute } from "@tanstack/react-router";

/**
 * Admin endpoint: manually finalize the HLS pipeline for a single video
 * whose MediaConvert webhook never fired (or fired but failed to pin).
 * Mirrors finalizeOwnTranscode but with admin auth instead of wallet sig.
 *
 *   POST /api/public/admin/finalize-hls?cid=<videoCid>
 *   POST /api/public/admin/finalize-hls?all=1&limit=20
 *     drains up to `limit` rows stuck in transcode_status='processing'
 *     whose MediaConvert job is actually COMPLETE in S3.
 *   header: x-admin-token: <TXC_RPC_PASS>
 */
export const Route = createFileRoute("/api/public/admin/finalize-hls")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        const url = new URL(request.url);
        const cid = url.searchParams.get("cid");
        const all = url.searchParams.get("all") === "1";
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 1),
          50,
        );

        const { retryFinalizePinFromS3 } = await import("@/lib/finalize-hls-pin.server");

        if (cid) {
          try {
            const result = await retryFinalizePinFromS3(cid);
            return Response.json({ ok: true, ...result });
          } catch (err) {
            return Response.json(
              { ok: false, error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        }

        if (!all) return new Response("Missing cid or all=1", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: rows, error } = await supabaseAdmin
          .from("videos")
          .select("cid, transcode_started_at")
          .eq("transcode_status", "processing")
          .order("transcode_started_at", { ascending: true })
          .limit(limit);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const results: Array<Record<string, unknown>> = [];
        for (const r of rows ?? []) {
          try {
            const res = await retryFinalizePinFromS3(r.cid);
            results.push({ cid: r.cid, action: "finalized", ...res });
          } catch (err) {
            results.push({
              cid: r.cid,
              action: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
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