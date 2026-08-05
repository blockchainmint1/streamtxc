import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { listVideosByOwner, restoreUnpinnedVideos } from "@/lib/videos.functions";
import { listCommentsByWallet } from "@/lib/comments.functions";
import { formatBytes } from "@/lib/fees";
import { shortWalletId } from "@/lib/wallet";
import { ipfsThumbUrl } from "@/lib/ipfs-gateway";
import { Copy, Check, Play, MessageSquare, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/u/$wallet")({
  head: ({ params }) => {
    const short = shortWalletId(params.wallet);
    const title = `Videos by ${short} — streamTXC`;
    const desc = `All videos uploaded by wallet ${params.wallet} on streamTXC — content-addressed on IPFS, paid in TXC.`;
    const url = `https://streamtxc.com/u/${params.wallet}`;
    return {
      meta: [
        { title },
        { name: "description", content: desc },
        { property: "og:title", content: title },
        { property: "og:description", content: desc },
        { property: "og:url", content: url },
        { property: "og:type", content: "profile" },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
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
  const restoreFn = useServerFn(restoreUnpinnedVideos);
  const [copied, setCopied] = useState(false);
  const [restoring, setRestoring] = useState(false);

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
  const expiredCount = items.filter(
    (v) => (v as { unpinned_at?: string | null }).unpinned_at != null,
  ).length;

  const handleRestore = async () => {
    setRestoring(true);
    try {
      const res = await restoreFn({ data: { wallet } });
      toast.success(
        `Asked our node to re-fetch ${res.queued}/${res.total} CID${res.total === 1 ? "" : "s"} from IPFS. Restoration runs asynchronously — check back in a few minutes.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Restore request failed",
      );
    } finally {
      setRestoring(false);
    }
  };

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
        {expiredCount > 0 && (
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-destructive/40 bg-destructive/5 rounded-sm p-4">
            <div className="font-mono text-xs text-muted-foreground">
              <span className="text-destructive font-bold">{expiredCount}</span>{" "}
              video{expiredCount === 1 ? "" : "s"} expired and got unpinned.
              Once renewal payment confirms, click below to ask IPFS peers to
              re-seed them into our pinning service.
            </div>
            <button
              onClick={handleRestore}
              disabled={restoring}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-mono text-xs uppercase tracking-wider rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${restoring ? "animate-spin" : ""}`} />
              {restoring ? "requesting…" : "restore from IPFS"}
            </button>
          </div>
        )}
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
              const vv = v as {
                unpinned_at?: string | null;
                payment_received_txc?: number | string | null;
                payment_required_txc?: number | string | null;
              };
              const expired = vv.unpinned_at != null;
              const received = Number(vv.payment_received_txc ?? 0);
              const required = Number(vv.payment_required_txc ?? 0);
              const renewing =
                expired && required > 0 && received >= required;
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
                    <div
                      className={`absolute top-2 left-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider rounded-sm ${renewing ? "bg-primary text-primary-foreground" : "bg-destructive text-destructive-foreground"}`}
                    >
                      {renewing ? "renewing" : "expired"}
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
                    <div
                      className={`mt-2 font-mono text-[11px] ${renewing ? "text-primary" : "text-destructive"}`}
                    >
                      {renewing
                        ? "renewal received — restoring from IPFS…"
                        : "hosting expired — renew to restore"}
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