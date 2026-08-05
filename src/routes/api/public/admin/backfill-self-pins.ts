import { createFileRoute } from "@tanstack/react-router";

/**
 * Admin endpoint: mirror existing public CIDs to our self-hosted
 * IPFS node (honest.money) via the IPFS lambda's pin-by-hash. Walks the
 * videos table in popularity order (view_count DESC, then created_at DESC).
 *
 *   POST /api/public/admin/backfill-self-pins?limit=50&offset=0
 *   header: x-admin-token: <TXC_RPC_PASS>
 *
 * Pins origin cid + hls_cid + metadata_cid + thumbnail_cid for each video
 * that has them. Returns counts + next offset for chained calls.
 */
export const Route = createFileRoute("/api/public/admin/backfill-self-pins")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const lambdaUrl = process.env.IPFS_LAMBDA_URL;
        const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
        if (!lambdaUrl || !lambdaToken) {
          return new Response("Self-node lambda not configured", { status: 503 });
        }

        const url = new URL(request.url);
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1),
          500,
        );
        const offset = Math.max(
          parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
          0,
        );

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: rows, error } = await supabaseAdmin
          .from("videos")
          .select("cid, hls_cid, metadata_cid, thumbnail_cid, title, view_count")
          .order("view_count", { ascending: false })
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const endpoint = `${lambdaUrl.replace(/\/$/, "")}/pin-cid`;
        async function mirror(cid: string, name: string): Promise<"ok" | "fail"> {
          try {
            const res = await fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${lambdaToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ cid, name }),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              console.warn(`mirror pin ${cid} [${res.status}]: ${text}`);
              return "fail";
            }
            return "ok";
          } catch (err) {
            console.warn(`mirror pin ${cid} threw`, err);
            return "fail";
          }
        }

        let pinned = 0;
        let failed = 0;
        const details: Array<{ cid: string; views: number; pinned: number; failed: number }> = [];
        for (const v of rows ?? []) {
          const targets: Array<{ cid: string; label: string }> = [];
          if (v.cid) targets.push({ cid: v.cid, label: `origin:${v.title ?? v.cid}` });
          if (v.hls_cid) targets.push({ cid: v.hls_cid, label: `hls:${v.cid}` });
          if (v.metadata_cid) targets.push({ cid: v.metadata_cid, label: `meta:${v.cid}` });
          if (v.thumbnail_cid) targets.push({ cid: v.thumbnail_cid, label: `thumb:${v.cid}` });
          let p = 0;
          let f = 0;
          for (const t of targets) {
            const r = await mirror(t.cid, t.label);
            if (r === "ok") {
              pinned++;
              p++;
            } else {
              failed++;
              f++;
            }
          }
          details.push({ cid: v.cid, views: Number(v.view_count ?? 0), pinned: p, failed: f });
        }

        return Response.json({
          ok: true,
          processedVideos: rows?.length ?? 0,
          pinnedCids: pinned,
          failedCids: failed,
          offset,
          limit,
          nextOffset: (rows?.length ?? 0) < limit ? null : offset + limit,
          details,
        });
      },
    },
  },
});