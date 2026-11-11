import { createFileRoute } from "@tanstack/react-router";
import { resolveGatewayUrl, fetchThroughGateways, serveGateway } from "@/lib/ipfs.server";
import { recordView } from "@/lib/videos.functions";
import { mediaResponseHeaders } from "@/lib/media-security";

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
        // Strict CID allowlist — never interpolate raw path segments into
        // PostgREST filter syntax (`.or()` treats commas/parens as syntax).
        const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{50,})$/;
        const cidIsValid = CID_RE.test(cid);
        // Count a view on playlist requests only (skip .ts segments).
        if (cidIsValid && splat.endsWith(".m3u8")) {
          try {
            const { supabaseAdmin } = await import(
              "@/integrations/supabase/client.server"
            );
            // Two safe .eq() lookups instead of string-interpolated .or().
            const [byCid, byHls] = await Promise.all([
              supabaseAdmin.from("videos").select("cid").eq("cid", cid).maybeSingle(),
              supabaseAdmin.from("videos").select("cid").eq("hls_cid", cid).maybeSingle(),
            ]);
            const v = byCid.data ?? byHls.data;
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
        // Same self-hosted gateway policy as /api/stream/$cid.
        // We probe the directory CID (cheap, single request) and append
        // the splat path to whichever gateway answers. For HLS bundles
        // this keeps all bundle requests on ipfs.honest.money.
        const base = await resolveGatewayUrl(cid);
        const target = `${base}/${splat}`;

        // Playlists must be PROXIED, not redirected. hls.js resolves relative
        // URLs against the response's final URL — after a 302 that's the IPFS
        // gateway origin, so variant playlists / segments get fetched
        // cross-origin and are blocked (no CORS on the gateway), leaving the
        // player stuck with readyState 0. Playlists are tiny text files, so
        // streaming them through our origin keeps every child URL same-origin.
        if (splat.endsWith(".m3u8")) {
          const hit = await fetchThroughGateways(cid, splat, {
            headers: { accept: "application/vnd.apple.mpegurl,*/*" },
          });
          if (!hit) {
            return new Response("Playlist not found", { status: 502 });
          }
          const body = await hit.res.text();
          const secureHeaders = mediaResponseHeaders("application/vnd.apple.mpegurl");
          secureHeaders.set("cache-control", "public, max-age=300, s-maxage=86400, stale-while-revalidate=86400");
          secureHeaders.set("access-control-allow-origin", "*");
          return new Response(body, {
            status: 200,
            headers: secureHeaders,
          });
        }

        // Media segments are content-addressed and immutable, so the
        // redirect can be cached. Without this every single .ts segment
        // paid an extra round trip through the Worker (~0.4-0.7s TTFB vs
        // 0.26s straight to the gateway), which is what made playback
        // feel sluggish. Bounded at 1h so a gateway change still
        // propagates quickly.
        const isSegment = /\.(ts|m4s|mp4|aac|vtt|jpg|jpeg|png|webp)$/i.test(splat);
        return serveGateway(target, request, isSegment ? "public, max-age=3600" : "no-store");
      },
    },
  },
});