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

        // Proxy from Pinata gateway with Range support.
        const upstream = gatewayUrl(cid);
        const range = request.headers.get("range");
        const upstreamRes = await fetch(upstream, {
          headers: range ? { Range: range } : {},
        });

        // Pass through status, content-type, content-length, accept-ranges, content-range.
        const headers = new Headers();
        const passthrough = [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "etag",
          "last-modified",
        ];
        for (const h of passthrough) {
          const v = upstreamRes.headers.get(h);
          if (v) headers.set(h, v);
        }
        headers.set("cache-control", "public, max-age=31536000, immutable");
        headers.set("access-control-allow-origin", "*");

        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers,
        });
      },
    },
  },
});