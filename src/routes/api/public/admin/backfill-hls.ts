import { createFileRoute } from "@tanstack/react-router";

/**
 * Admin endpoint: backfill old videos (origin cid only, no hls bundle) into
 * the HLS pipeline. Pulls origin from IPFS, pushes to S3, kicks MediaConvert.
 * The webhook + finalize-hls path handles pinning + on-chain metadata.
 *
 *   POST /api/public/admin/backfill-hls?limit=10
 *     header: x-admin-token: <TXC_RPC_PASS>
 *
 *   POST /api/public/admin/backfill-hls?cid=<cid>
 *     header: x-admin-token: <TXC_RPC_PASS>
 */
export const Route = createFileRoute("/api/public/admin/backfill-hls")({
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
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 1),
          50,
        );

        const { backfillOneHls, pickBackfillCandidates } = await import(
          "@/lib/backfill-hls.server"
        );

        if (cidParam) {
          try {
            const r = await backfillOneHls(cidParam);
            return Response.json({ ok: true, ...r });
          } catch (err) {
            return Response.json(
              { ok: false, cid: cidParam, error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        }

        const candidates = await pickBackfillCandidates(limit);
        const results: Array<Record<string, unknown>> = [];
        for (const row of candidates) {
          try {
            const r = await backfillOneHls(row.cid);
            results.push({ action: "queued", ...r });
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