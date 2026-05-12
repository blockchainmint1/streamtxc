import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { VideoPlayer } from "@/components/VideoPlayer";
import { Button } from "@/components/ui/button";
import { getVideo } from "@/lib/videos.functions";
import { formatBytes, shortenHash, formatTxc } from "@/lib/fees";
import {
  Copy,
  ExternalLink,
  Eye,
  Calendar,
  Hash,
  Check,
  Code2,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/v/$cid")({
  component: WatchPage,
});

function WatchPage() {
  const { cid } = Route.useParams();
  const fetchVideo = useServerFn(getVideo);
  const { data: video, isLoading } = useQuery({
    queryKey: ["video", cid],
    queryFn: () => fetchVideo({ data: { cid } }),
  });

  const [embedW, setEmbedW] = useState(640);
  const [embedH, setEmbedH] = useState(360);
  const [autoplay, setAutoplay] = useState(false);
  const [muted, setMuted] = useState(false);
  const [startAt, setStartAt] = useState(0);
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center font-mono text-muted-foreground">
          Loading…
        </div>
      </div>
    );
  }

  if (!video) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <h1 className="text-2xl font-bold">Video not found</h1>
          <Link to="/">
            <Button variant="outline">Go home</Button>
          </Link>
        </div>
      </div>
    );
  }

  const streamUrl = `/api/stream/${video.cid}`;
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const embedSrc = `${origin}/embed/${video.cid}?${new URLSearchParams({
    ...(autoplay ? { autoplay: "1" } : {}),
    ...(muted ? { mute: "1" } : {}),
    ...(startAt ? { t: String(startAt) } : {}),
  }).toString()}`;
  const embedCode = `<iframe src="${embedSrc}" width="${embedW}" height="${embedH}" allow="autoplay; fullscreen" frameborder="0"></iframe>`;

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 py-8 flex-1">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Player + meta */}
          <div className="lg:col-span-2 space-y-4">
            <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden">
              <VideoPlayer src={streamUrl} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{video.title}</h1>
            {video.description && (
              <p className="text-muted-foreground whitespace-pre-wrap">
                {video.description}
              </p>
            )}
            <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground border-t border-border pt-4">
              <span className="flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" /> {video.view_count} views
              </span>
              <span className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {new Date(video.created_at).toLocaleDateString()}
              </span>
              <span>{formatBytes(video.size_bytes)}</span>
              <span>uploader: {shortenHash(video.owner_wallet)}</span>
            </div>
          </div>

          {/* Sidebar: chain info + embed */}
          <div className="space-y-4">
            <div className="border border-border bg-card rounded-sm p-4 space-y-3">
              <h2 className="font-mono text-xs text-primary">[ ON-CHAIN PROOF ]</h2>
              <Field label="IPFS CID" value={video.cid} onCopy={copy} mono />
              {video.mock_tx_hash && (
                <Field
                  label="TXC tx hash"
                  value={video.mock_tx_hash}
                  href={`https://explorer.texitcoin.org/tx/${video.mock_tx_hash}`}
                  onCopy={copy}
                  mono
                />
              )}
              {video.mock_block_number && (
                <Field
                  label="Block #"
                  value={String(video.mock_block_number)}
                  mono
                />
              )}
              <Field label="Status" value={video.status} mono />
              <Field
                label="Expires"
                value={new Date(video.expires_at).toLocaleDateString()}
                mono
              />
            </div>

            <div className="border border-border bg-card rounded-sm p-4 space-y-3">
              <h2 className="font-mono text-xs text-primary flex items-center gap-1.5">
                <Code2 className="h-3.5 w-3.5" /> [ EMBED ]
              </h2>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={autoplay}
                    onChange={(e) => setAutoplay(e.target.checked)}
                  />
                  autoplay
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={muted}
                    onChange={(e) => setMuted(e.target.checked)}
                  />
                  muted
                </label>
                <label className="flex items-center gap-2 col-span-2">
                  start at (s):
                  <input
                    type="number"
                    value={startAt}
                    onChange={(e) => setStartAt(Number(e.target.value))}
                    className="bg-input border border-border rounded-sm px-2 py-1 w-20"
                    min={0}
                  />
                </label>
                <label className="flex items-center gap-2">
                  w:
                  <input
                    type="number"
                    value={embedW}
                    onChange={(e) => setEmbedW(Number(e.target.value))}
                    className="bg-input border border-border rounded-sm px-2 py-1 w-full"
                  />
                </label>
                <label className="flex items-center gap-2">
                  h:
                  <input
                    type="number"
                    value={embedH}
                    onChange={(e) => setEmbedH(Number(e.target.value))}
                    className="bg-input border border-border rounded-sm px-2 py-1 w-full"
                  />
                </label>
              </div>
              <textarea
                readOnly
                value={embedCode}
                className="w-full h-24 bg-input border border-border rounded-sm p-2 font-mono text-[10px] resize-none"
              />
              <Button
                size="sm"
                onClick={() => copy(embedCode)}
                className="w-full font-mono"
              >
                {copied ? (
                  <>
                    <Check className="mr-2 h-3 w-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-3 w-3" /> Copy embed code
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function Field({
  label,
  value,
  href,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  href?: string;
  onCopy?: (s: string) => void;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div className="flex items-center gap-2 mt-0.5">
        <span
          className={`flex-1 truncate text-xs ${mono ? "font-mono" : ""}`}
          title={value}
        >
          {value}
        </span>
        {onCopy && (
          <button
            onClick={() => onCopy(value)}
            className="text-muted-foreground hover:text-primary"
            aria-label={`Copy ${label}`}
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-primary"
            aria-label={`Open ${label}`}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}