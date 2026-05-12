import { createFileRoute } from "@tanstack/react-router";
import { retryAllStuckStamps } from "@/lib/stamp-retry.server";

// TEMPORARY one-shot endpoint to recover from the empty-wallet outage.
// Will be deleted after running.
export const Route = createFileRoute("/api/public/admin/retry-now")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const results = await retryAllStuckStamps();
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
