import { createFileRoute } from "@tanstack/react-router";
import { secretMatches } from "@/lib/admin-token";

/**
 * Admin endpoint: backfill closed captions on existing videos.
 *
 *   POST /api/public/admin/backfill-transcripts?limit=10
 *     header: x-admin-token: <TXC_RPC_PASS>
 *
 *   POST /api/public/admin/backfill-transcripts?cid=<cid>
 *     header: x-admin-token: <TXC_RPC_PASS>
 */
export const Route = createFileRoute("/api/public/admin/backfill-transcripts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!secretMatches(provided, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const url = new URL(request.url);
        const cidParam = url.searchParams.get("cid");
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 1),
          50,
        );

        const { backfillOneTranscript, pickTranscriptCandidates } = await import(
          "@/lib/backfill-transcripts.server"
        );

        if (cidParam) {
          try {
            const r = await backfillOneTranscript(cidParam);
            return Response.json({ ok: true, ...r });
          } catch (err) {
            return Response.json(
              {
                ok: false,
                cid: cidParam,
                error: err instanceof Error ? err.message : String(err),
              },
              { status: 500 },
            );
          }
        }

        const candidates = await pickTranscriptCandidates(limit);
        const results: Array<Record<string, unknown>> = [];
        for (const row of candidates) {
          try {
            const r = await backfillOneTranscript(row.cid);
            results.push(r);
          } catch (err) {
            results.push({
              cid: row.cid,
              action: "failed",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return Response.json({
          ok: true,
          considered: candidates.length,
          results,
        });
      },
    },
  },
});