import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

const BASE_URL = "https://streamtxc.com";

interface SitemapEntry {
  path: string;
  lastmod?: string;
  changefreq?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: string;
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const entries: SitemapEntry[] = [
          { path: "/", changefreq: "hourly", priority: "1.0" },
          { path: "/about", changefreq: "monthly", priority: "0.8" },
          { path: "/manifesto", changefreq: "monthly", priority: "0.6" },
          { path: "/brand", changefreq: "monthly", priority: "0.4" },
          { path: "/api", changefreq: "monthly", priority: "0.4" },
          { path: "/terms", changefreq: "yearly", priority: "0.3" },
          { path: "/privacy", changefreq: "yearly", priority: "0.3" },
        ];

        try {
          const { supabaseAdmin } = await import(
            "@/integrations/supabase/client.server"
          );
          const { data: videos } = await supabaseAdmin
            .from("videos")
            .select("cid, owner_wallet, created_at")
            .in("status", ["active", "mempool"])
            .is("hidden_at", null)
            .eq("is_nsfw", false)
            .order("created_at", { ascending: false })
            .limit(5000);

          const wallets = new Set<string>();
          for (const v of videos ?? []) {
            entries.push({
              path: `/v/${v.cid}`,
              lastmod: v.created_at?.slice(0, 10),
              changefreq: "weekly",
              priority: "0.7",
            });
            if (v.owner_wallet) wallets.add(v.owner_wallet);
          }
          for (const wallet of wallets) {
            entries.push({
              path: `/u/${wallet}`,
              changefreq: "weekly",
              priority: "0.5",
            });
          }
        } catch (err) {
          console.error("sitemap: failed to load dynamic routes", err);
        }

        const urls = entries.map((e) =>
          [
            `  <url>`,
            `    <loc>${BASE_URL}${e.path}</loc>`,
            e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
            e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : null,
            e.priority ? `    <priority>${e.priority}</priority>` : null,
            `  </url>`,
          ]
            .filter(Boolean)
            .join("\n"),
        );

        const xml = [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
          ...urls,
          `</urlset>`,
        ].join("\n");

        return new Response(xml, {
          headers: {
            "Content-Type": "application/xml",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});