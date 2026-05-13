import { createFileRoute } from "@tanstack/react-router";
import { recordView } from "@/lib/videos.functions";
import { buildIpfsUrl, getIpfsGateways } from "@/lib/ipfsGateway";

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

        // Proxy through configured gateways with fallback so the frontend
        // never has to know which gateway works. Range/If-* headers are
        // forwarded so HTTP byte-range seeking still works.
        const range = request.headers.get("range") ?? undefined;
        const ifRange = request.headers.get("if-range") ?? undefined;
        const accept = request.headers.get("accept") ?? undefined;

        const gateways = getIpfsGateways();
        let lastStatus = 0;
        let lastBody = "All IPFS gateways failed";
        for (const gw of gateways) {
          const url = buildIpfsUrl(gw, cid);
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 12_000);
          try {
            const upstream = await fetch(url, {
              method: "GET",
              headers: {
                ...(range ? { Range: range } : {}),
                ...(ifRange ? { "If-Range": ifRange } : {}),
                ...(accept ? { Accept: accept } : {}),
              },
              signal: ctl.signal,
              redirect: "follow",
            });
            // 2xx (incl. 206 partial) and 304 are good. 416 is a legitimate
            // client-error response we want to pass through.
            const passthrough =
              (upstream.status >= 200 && upstream.status < 300) ||
              upstream.status === 304 ||
              upstream.status === 416;
            if (!passthrough) {
              lastStatus = upstream.status;
              lastBody = `Gateway ${gw} returned ${upstream.status}`;
              try {
                await upstream.arrayBuffer();
              } catch {
                /* ignore */
              }
              continue;
            }
            const headers = new Headers();
            const passHeaders = [
              "content-type",
              "content-length",
              "content-range",
              "accept-ranges",
              "etag",
              "last-modified",
            ];
            for (const h of passHeaders) {
              const v = upstream.headers.get(h);
              if (v) headers.set(h, v);
            }
            headers.set("access-control-allow-origin", "*");
            headers.set("cache-control", "public, max-age=3600");
            return new Response(upstream.body, {
              status: upstream.status,
              headers,
            });
          } catch (err) {
            lastBody =
              err instanceof Error && err.name === "AbortError"
                ? `Gateway ${gw} timed out`
                : err instanceof Error
                  ? err.message
                  : `Gateway ${gw} failed`;
          } finally {
            clearTimeout(t);
          }
        }

        console.error("stream proxy: all gateways failed", {
          cid,
          lastStatus,
          lastBody,
        });
        return new Response(lastBody, {
          status: 502,
          headers: { "access-control-allow-origin": "*" },
        });
      },
    },
  },
});