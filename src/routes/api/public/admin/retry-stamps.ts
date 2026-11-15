import { createFileRoute } from "@tanstack/react-router";
import { retryAllStuckStamps, retryStuckStampForVideo } from "@/lib/stamp-retry.server";
import { secretMatches } from "@/lib/admin-token";

/**
 * Admin endpoint: re-broadcasts the C/T OP_RETURN stamps for any video
 * stuck in `stamp_failed` (e.g. uploaded while the TXC hot wallet was
 * empty). Guarded by the `x-admin-token` header which must match
 * TXC_RPC_PASS (already a server secret).
 *
 *   POST /api/public/admin/retry-stamps                  → retries all
 *   POST /api/public/admin/retry-stamps?cid=<videoCid>   → retries one
 */
export const Route = createFileRoute("/api/public/admin/retry-stamps")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!secretMatches(provided, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const url = new URL(request.url);
        const cid = url.searchParams.get("cid");
        try {
          const results = cid
            ? [await retryStuckStampForVideo(cid)]
            : await retryAllStuckStamps();
          return Response.json({ ok: true, count: results.length, results });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },
  },
});