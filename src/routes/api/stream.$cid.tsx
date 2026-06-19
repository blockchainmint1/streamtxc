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

export const Route = createFileRoute("/api/stream/$cid")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const cid = params.cid;
        if (!cid || cid.length > 200) {
          return new Response("Bad CID", { status: 400 });
        }

        const ip =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown";
        const ipHash = await hashIp(ip);

        // Track the view BEFORE returning. On Cloudflare Workers, any
        // promise that isn't awaited (or wrapped in ctx.waitUntil) gets
        // killed the moment the Response is sent — which means a naive
        // fire-and-forget recordView() silently drops most views. The
        // debounce + insert + counter update is two quick round-trips, so
        // awaiting it adds only a few ms to the redirect.
        try {
          await recordView(cid, ipHash);
        } catch (e) {
          console.error("view tracking failed", e);
        }

        // Redirect the browser straight to our dedicated Pinata gateway.
        // Streaming through the Worker added a hop and CPU/subrequest cost;
        // a 302 lets the player do native HTTP Range requests against Pinata
        // directly, which is dramatically faster on a paid dedicated gateway.
        // IMPORTANT: do NOT cache the redirect — caching it means rewatches
        // never hit the Worker, so recordView() never runs and view_count
        // gets stuck at 1. The actual video bytes are still cached by Pinata
        // and the browser via Range requests, so this only costs us a tiny
        // 302 per playback.
        // Self-node first, Pinata fallback. HEAD-probes the self-hosted
        // gateway with a short timeout; if it can't serve this CID (e.g.
        // pin hasn't been mirrored yet) we 302 to Pinata so the player
        // never sees a hang. See mem://constraints/ipfs-gateway-fallback.
        const location = await resolveGatewayUrl(cid);
        return new Response(null, {
          status: 302,
          headers: {
            location,
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});