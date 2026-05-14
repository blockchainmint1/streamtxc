import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { listVideosByOwner } from "@/lib/videos.functions";
import { listCommentsByWallet } from "@/lib/comments.functions";
import { formatBytes } from "@/lib/fees";
import { shortWalletId } from "@/lib/wallet";
import { ipfsThumbUrl } from "@/lib/ipfs-gateway";
import { Copy, Check, Play, MessageSquare } from "lucide-react";

export const Route = createFileRoute("/u/$wallet")({
  head: ({ params }) => ({
    meta: [
      { title: `Videos by ${params.wallet} — streamTXC` },
      {
        name: "description",
        content: `All videos uploaded by wallet ${params.wallet} on streamTXC.`,
      },
      { property: "og:title", content: `Videos by ${shortWalletId(params.wallet)} — streamTXC` },
      {
        property: "og:description",
        content: `All videos uploaded by wallet ${params.wallet} on streamTXC.`,
      },
    ],
  }),
  component: WalletPage,
  errorComponent: ({ error }) => (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <div className="mx-auto max-w-3xl px-6 py-16 font-mono text-sm text-destructive">
        Failed to load videos: {error.message}
      </div>
    </div>
  ),
});

function WalletPage() {
  const { wallet } = Route.useParams();
  const fetchByOwner = useServerFn(listVideosByOwner);
  const fetchComments = useServerFn(listCommentsByWallet);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["videos-by-owner", wallet],
    queryFn: () => fetchByOwner({ data: { wallet } }),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ["comments-by-wallet", wallet],
    queryFn: () => fetchComments({ data: { wallet } }),
    staleTime: 0,
    refetchOnMount: "always",
  });

  const items = data?.items ?? [];
  const comments = commentsData ?? [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <section className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8 border-b border-border pb-6">
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            channel
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            Videos by{" "}
            <span className="text-primary font-mono">
              {shortWalletId(wallet)}
            </span>
          </h1>
          <button
            onClick={copy}
            title="Copy full address"
            className="mt-3 inline-flex items-center gap-2 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors break-all"
          >
            <span>{wallet}</span>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-primary shrink-0" />
            ) : (
              <Copy className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
        </div>

        <h2 className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-3">
          videos
        </h2>
        {isLoading ? (
          <div className="font-mono text-sm text-muted-foreground">
            loading…
          </div>
        ) : items.length === 0 ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center font-mono text-sm text-muted-foreground">
            No videos from this wallet yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((v) => {
              const expired = (v as any).status === "unpinned";
              return (
              <Link
                key={v.cid}
                to="/v/$cid"
                params={{ cid: v.cid }}
                className={`group block bg-card border rounded-sm overflow-hidden transition-colors ${expired ? "border-destructive/40 hover:border-destructive opacity-70" : "border-border hover:border-primary"}`}
              >
                <div className="relative aspect-video bg-secondary overflow-hidden">
                  {v.thumbnail_cid ? (
                    <img
                      src={ipfsThumbUrl(v.thumbnail_cid)}
                      alt={v.title}
                      loading="lazy"
                      className={`absolute inset-0 h-full w-full object-cover ${expired ? "grayscale" : ""}`}
                    />
                  ) : (
                    <video
                      src={`/api/stream/${v.cid}#t=0.5`}
                      preload="metadata"
                      muted
                      playsInline
                      className={`absolute inset-0 h-full w-full object-cover ${expired ? "grayscale" : ""}`}
                    />
                  )}
                  {expired && (
                    <div className="absolute top-2 left-2 px-2 py-0.5 bg-destructive text-destructive-foreground font-mono text-[10px] uppercase tracking-wider rounded-sm">
                      expired
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-background/0 group-hover:bg-background/30 transition-colors">
                    <Play className="h-10 w-10 text-background opacity-0 group-hover:opacity-100 fill-background transition-opacity" />
                  </div>
                </div>
                <div className="p-4">
                  <h3 className="font-bold text-sm truncate">{v.title}</h3>
                  <div className="mt-2 flex justify-between font-mono text-xs text-muted-foreground">
                    <span>{v.view_count} views</span>
                    <span>{formatBytes(v.size_bytes)}</span>
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground/60 truncate">
                    {v.cid}
                  </div>
                  {expired && (
                    <div className="mt-2 font-mono text-[11px] text-destructive">
                      hosting expired — renew to restore
                    </div>
                  )}
                </div>
              </Link>
              );
            })}
          </div>
        )}

        <h2 className="mt-12 font-mono text-xs uppercase tracking-wider text-muted-foreground mb-3">
          comments
        </h2>
        {commentsLoading ? (
          <div className="font-mono text-sm text-muted-foreground">
            loading…
          </div>
        ) : comments.length === 0 ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center font-mono text-sm text-muted-foreground">
            No comments from this wallet yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {comments.map((c) => {
              const body =
                c.body.length > 280 ? c.body.slice(0, 280) + "…" : c.body;
              const boost = Number(c.boost_total_txc ?? 0);
              return (
                <li
                  key={c.id}
                  className="bg-card border border-border rounded-sm p-4 hover:border-primary transition-colors"
                >
                  <Link
                    to="/v/$cid"
                    params={{ cid: c.video_cid }}
                    className="block"
                  >
                    <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground mb-2">
                      <MessageSquare className="h-3.5 w-3.5" />
                      <span className="truncate">
                        on{" "}
                        <span className="text-foreground">
                          {c.videoTitle ?? c.video_cid.slice(0, 12) + "…"}
                        </span>
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {body}
                    </p>
                    <div className="mt-2 flex gap-3 font-mono text-[11px] text-muted-foreground">
                      <span>
                        {new Date(c.created_at).toLocaleDateString()}
                      </span>
                      {boost > 0 && (
                        <span className="text-primary">
                          ★ {boost.toFixed(2)} TXC
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <Footer />
    </div>
  );
}