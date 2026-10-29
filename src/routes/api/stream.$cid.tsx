import { createFileRoute } from "@tanstack/react-router";
import { resolveGatewayUrl, serveGateway } from "@/lib/ipfs.server";
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

        // Thumbnails/posters hit this same endpoint. They are immutable
        // content-addressed images and are NOT playbacks, so skip the
        // view-tracking round trip and let the browser/CDN cache the
        // redirect. Before this, every card on the home page paid ~1s
        // (gateway probe + DB write) on every render.
        const dest = request.headers.get("sec-fetch-dest");
        const accept = request.headers.get("accept") ?? "";
        const isImage = dest === "image" || accept.startsWith("image/");
        if (isImage) {
          const target = await resolveGatewayUrl(cid);
          return serveGateway(target, request, "public, max-age=3600");
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

        // Redirect the browser straight to our dedicated IPFS gateway.
        // Streaming through the Worker added a hop and CPU/subrequest cost;
        // a 302 lets the player do native HTTP Range requests against IPFS
        // directly, which is dramatically faster on a paid dedicated gateway.
        // IMPORTANT: do NOT cache the redirect — caching it means rewatches
        // never hit the Worker, so recordView() never runs and view_count
        // gets stuck at 1. The actual video bytes are still cached by the gateway
        // and the browser via Range requests, so this only costs us a tiny
        // 302 per playback.
        // All media resolves through the self-hosted gateway.
        const location = await resolveGatewayUrl(cid);
        return serveGateway(location, request, "no-store");
      },
    },
  },
});