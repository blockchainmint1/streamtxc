import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { listRecentVideos } from "@/lib/videos.functions";
import { formatBytes, shortenHash } from "@/lib/fees";
import { ArrowUpRight, Upload, Database, Coins, Eye } from "lucide-react";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const fetchRecent = useServerFn(listRecentVideos);
  const { data: videos } = useQuery({
    queryKey: ["recent-videos"],
    queryFn: () => fetchRecent(),
  });

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      {/* Hero */}
      <section className="mx-auto w-full max-w-7xl px-6 pt-24 pb-16">
        <div className="font-mono text-xs text-primary mb-6">
          [ DECENTRALIZED · WALLET-NATIVE · UNCENSORABLE ]
        </div>
        <h1 className="text-5xl md:text-7xl font-bold tracking-tighter leading-[0.95] max-w-4xl">
          Video that lives on{" "}
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: "var(--gradient-primary)" }}
          >
            IPFS
          </span>
          .
          <br />
          Proved on{" "}
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: "var(--gradient-primary)" }}
          >
            TXC
          </span>
          .
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted-foreground">
          Upload a video. Pay TXC by file size. Get a content hash timestamped
          on-chain. Stream it anywhere. No accounts, no platforms, no takedowns.
        </p>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link to="/upload">
            <Button size="lg" className="font-mono">
              <Upload className="mr-2 h-4 w-4" /> Upload a video
            </Button>
          </Link>
          <Link to="/manage">
            <Button size="lg" variant="outline" className="font-mono">
              My videos <ArrowUpRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>

        {/* Pillars */}
        <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-px bg-border border border-border rounded-sm overflow-hidden">
          {[
            {
              icon: Database,
              title: "Pinned to IPFS",
              body: "Files pinned via Pinata. Your CID is the address — anyone can verify it, no one can rewrite it.",
            },
            {
              icon: Coins,
              title: "Pay-per-MB in TXC",
              body: "Hosting priced in TXC by file size and months prepaid. Wallet signs, chain timestamps your CID.",
            },
            {
              icon: Eye,
              title: "Earn from views",
              body: "Popular videos accrue creator credits. Dead videos expire. Storage flows where attention is.",
            },
          ].map((p) => (
            <div key={p.title} className="bg-card p-6">
              <p.icon className="h-5 w-5 text-primary mb-3" />
              <h3 className="font-mono text-sm font-bold mb-2">{p.title}</h3>
              <p className="text-sm text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Recent videos */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-24">
        <div className="flex items-baseline justify-between mb-6">
          <h2 className="text-2xl font-bold tracking-tight">Recent uploads</h2>
          <span className="font-mono text-xs text-muted-foreground">
            {videos?.length ?? 0} active
          </span>
        </div>
        {!videos || videos.length === 0 ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center font-mono text-sm text-muted-foreground">
            No videos yet. Be the first.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {videos.map((v) => (
              <Link
                key={v.cid}
                to="/v/$cid"
                params={{ cid: v.cid }}
                className="group block bg-card border border-border rounded-sm overflow-hidden hover:border-primary transition-colors"
              >
                <div className="aspect-video bg-secondary flex items-center justify-center">
                  <Database className="h-8 w-8 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="p-4">
                  <h3 className="font-bold text-sm truncate">{v.title}</h3>
                  <div className="mt-2 flex justify-between font-mono text-xs text-muted-foreground">
                    <span>{shortenHash(v.owner_wallet)}</span>
                    <span>
                      {v.view_count} views · {formatBytes(v.size_bytes)}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground/60 truncate">
                    {v.cid}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <Footer />
    </div>
  );
}
