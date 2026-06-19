import { createFileRoute } from "@tanstack/react-router";
import { resolveGatewayUrl } from "@/lib/pinata.server";
import { recordView } from "@/lib/videos.functions";

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Splat-path version of /api/stream/:cid for IPFS *directories* (e.g. HLS
 * bundles). The HLS master playlist lives at `/api/stream/{dirCid}/master.m3u8`
 * and references segments by relative path, so hls.js fetches
 * `/api/stream/{dirCid}/720p/segment_00001.ts` etc. — all redirected here.
 *
 * View tracking is intentionally skipped: this is one fetch per *segment*,
 * not per video. We DO count when the splat ends in `.m3u8` (master or
 * rendition playlist) — the parent `/api/stream/:cid` route is never hit
 * for HLS videos because the player URL points directly at the splat
 * (`/api/stream/{hlsCid}/hls/{sourceCid}/{sourceCid}.m3u8`). The 30s
 * debounce in recordView() dedupes master+rendition fetches into one view.
 */
export const Route = createFileRoute("/api/stream/$cid/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const cid = params.cid;
        const splat = params._splat ?? "";
        if (!cid || cid.length > 200 || splat.length > 500) {
          return new Response("Bad path", { status: 400 });
        }
        // Count a view on playlist requests only (skip .ts segments).
        if (splat.endsWith(".m3u8")) {
          try {
            const { supabaseAdmin } = await import(
              "@/integrations/supabase/client.server"
            );
            const { data: v } = await supabaseAdmin
              .from("videos")
              .select("cid")
              .or(`cid.eq.${cid},hls_cid.eq.${cid}`)
              .maybeSingle();
            if (v?.cid) {
              const ip =
                request.headers.get("cf-connecting-ip") ??
                request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
                "unknown";
              await recordView(v.cid, await hashIp(ip));
            }
          } catch (e) {
            console.error("view tracking (hls) failed", e);
          }
        }
        // Same self-first / Pinata-fallback policy as /api/stream/$cid.
        // We probe the directory CID (cheap, single request) and append
        // the splat path to whichever gateway answers. For HLS bundles
        // this means a missing self-node pin still streams via Pinata.
        const base = await resolveGatewayUrl(cid);
        return new Response(null, {
          status: 302,
          headers: {
            location: `${base}/${splat}`,
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});