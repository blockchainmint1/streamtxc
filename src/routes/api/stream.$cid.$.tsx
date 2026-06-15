import { createFileRoute } from "@tanstack/react-router";
import { gatewayUrl } from "@/lib/pinata.server";

/**
 * Splat-path version of /api/stream/:cid for IPFS *directories* (e.g. HLS
 * bundles). The HLS master playlist lives at `/api/stream/{dirCid}/master.m3u8`
 * and references segments by relative path, so hls.js fetches
 * `/api/stream/{dirCid}/720p/segment_00001.ts` etc. — all redirected here.
 *
 * View tracking is intentionally skipped: this is one fetch per *segment*,
 * not per video. The parent `/api/stream/:cid` route still counts a view
 * when the player first resolves the master URL through the legacy path.
 */
export const Route = createFileRoute("/api/stream/$cid/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const cid = params.cid;
        const splat = params._splat ?? "";
        if (!cid || cid.length > 200 || splat.length > 500) {
          return new Response("Bad path", { status: 400 });
        }
        return new Response(null, {
          status: 302,
          headers: {
            location: `${gatewayUrl(cid)}/${splat}`,
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});