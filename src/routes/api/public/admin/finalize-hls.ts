import { createFileRoute } from "@tanstack/react-router";

/**
 * Admin endpoint: manually finalize the HLS pipeline for a single video
 * whose MediaConvert webhook never fired (or fired but failed to pin).
 * Mirrors finalizeOwnTranscode but with admin auth instead of wallet sig.
 *
 *   POST /api/public/admin/finalize-hls?cid=<videoCid>
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
        const cid = new URL(request.url).searchParams.get("cid");
        if (!cid) return new Response("Missing cid", { status: 400 });

        try {
          const { retryFinalizePinFromS3 } = await import("@/lib/finalize-hls-pin.server");
          const result = await retryFinalizePinFromS3(cid);
          return Response.json({ ok: true, ...result });
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