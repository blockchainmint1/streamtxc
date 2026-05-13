import { createFileRoute } from "@tanstack/react-router";
import { gatewayUrl } from "@/lib/pinata.server";
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

        // Fire-and-forget view tracking (debounced server-side).
        recordView(cid, ipHash).catch((e) =>
          console.error("view tracking failed", e),
        );

        // Redirect the browser straight to our dedicated Pinata gateway.
        // Streaming through the Worker added a hop and CPU/subrequest cost;
        // a 302 lets the player do native HTTP Range requests against Pinata
        // directly, which is dramatically faster on a paid dedicated gateway.
        // IMPORTANT: do NOT cache the redirect — caching it means rewatches
        // never hit the Worker, so recordView() never runs and view_count
        // gets stuck at 1. The actual video bytes are still cached by Pinata
        // and the browser via Range requests, so this only costs us a tiny
        // 302 per playback.
        return new Response(null, {
          status: 302,
          headers: {
            location: gatewayUrl(cid),
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  },
});