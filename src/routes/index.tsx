import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { listRecentVideos } from "@/lib/videos.functions";
import { formatBytes, shortenHash } from "@/lib/fees";
import { ArrowUpRight, Upload, Database, Coins, Eye, Play } from "lucide-react";

type SortKey = "newest" | "most-viewed" | "expensive" | "comments" | "leaving-soon";
const PAGE = 9;
const SORTS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "newest" },
  { key: "most-viewed", label: "most viewed" },
  { key: "expensive", label: "most expensive" },
  { key: "comments", label: "most comments" },
  { key: "leaving-soon", label: "leaving soon" },
];

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const fetchRecent = useServerFn(listRecentVideos);
  const [sort, setSort] = useState<SortKey>("newest");
  const [offset, setOffset] = useState(0);
  const [accum, setAccum] = useState<
    Awaited<ReturnType<typeof listRecentVideos>>["items"]
  >([]);

  const { data, isFetching } = useQuery({
    queryKey: ["recent-videos", sort, offset],
    queryFn: () => fetchRecent({ data: { sort, limit: PAGE, offset } }),
  });

  useEffect(() => {
    if (!data) return;
    setAccum((prev) => (offset === 0 ? data.items : [...prev, ...data.items]));
  }, [data, offset]);

  useEffect(() => {
    setOffset(0);
    setAccum([]);
  }, [sort]);

  const total = data?.total ?? 0;
  const hasMore = accum.length < total;

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
          Proved up on{" "}
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
        <div className="flex flex-wrap items-baseline justify-between gap-4 mb-6">
          <h2 className="text-2xl font-bold tracking-tight">Recent uploads</h2>
          <span className="font-mono text-xs text-muted-foreground">
            {total} active
          </span>
        </div>
        <div className="mb-6 flex flex-wrap gap-1 border-b border-border">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              className={`px-3 py-2 font-mono text-xs transition-colors border-b-2 -mb-px ${
                sort === s.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {accum.length === 0 && !isFetching ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center font-mono text-sm text-muted-foreground">
            No videos yet. Be the first.
          </div>
        ) : (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {accum.map((v) => (
              <Link
                key={v.cid}
                to="/v/$cid"
                params={{ cid: v.cid }}
                className="group block bg-card border border-border rounded-sm overflow-hidden hover:border-primary transition-colors"
              >
                <div className="relative aspect-video bg-secondary overflow-hidden">
                  <video
                    src={`/api/stream/${v.cid}#t=0.5`}
                    preload="metadata"
                    muted
                    playsInline
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-background/0 group-hover:bg-background/30 transition-colors">
                    <Play className="h-10 w-10 text-background opacity-0 group-hover:opacity-100 fill-background transition-opacity" />
                  </div>
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
          {hasMore && (
            <div className="mt-8 flex justify-center">
              <Button
                variant="outline"
                className="font-mono"
                disabled={isFetching}
                onClick={() => setOffset((o) => o + PAGE)}
              >
                {isFetching ? "loading…" : "load more"}
              </Button>
            </div>
          )}
          </>
        )}
      </section>

      <Footer />
    </div>
  );
}
