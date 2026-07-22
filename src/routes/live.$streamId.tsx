import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { VideoPlayerV2 } from "@/components/VideoPlayerV2";
import { LiveChat } from "@/components/LiveChat";
import { Youtube, Twitter, Facebook, Eye, ChevronLeft, Code2 } from "lucide-react";
import { useLiveViewerCount } from "@/hooks/useLiveViewerCount";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

export const Route = createFileRoute("/live/$streamId")({
  head: () => ({
    meta: [
      { title: "Live stream — streamTXC" },
      { name: "description", content: "Watch this live broadcast on streamTXC." },
      { property: "og:type", content: "video.other" },
    ],
  }),
  component: LiveStreamPage,
  errorComponent: ({ error }) => (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-12 text-center">
        <h1 className="text-2xl font-bold mb-2">Stream unavailable</h1>
        <p className="text-muted-foreground font-mono text-sm">{error.message}</p>
        <Link to="/live" className="inline-flex items-center gap-1 mt-4 font-mono text-xs text-primary hover:underline">
          <ChevronLeft className="h-3 w-3" /> Back to live
        </Link>
      </main>
      <Footer />
    </div>
  ),
  notFoundComponent: () => (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-12 text-center">
        <h1 className="text-2xl font-bold mb-2">Stream not found</h1>
        <Link to="/live" className="inline-flex items-center gap-1 mt-4 font-mono text-xs text-primary hover:underline">
          <ChevronLeft className="h-3 w-3" /> Back to live
        </Link>
      </main>
      <Footer />
    </div>
  ),
});

interface Stream {
  id: string;
  title: string;
  description: string | null;
  thumbnail_cid: string | null;
  hls_url: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  simulcast_youtube_url: string | null;
  simulcast_twitter_url: string | null;
  simulcast_facebook_url: string | null;
}

function LiveStreamPage() {
  const { streamId } = Route.useParams();
  const [stream, setStream] = useState<Stream | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from("live_streams")
        .select("id,title,description,thumbnail_cid,hls_url,status,started_at,ended_at,simulcast_youtube_url,simulcast_twitter_url,simulcast_facebook_url")
        .eq("id", streamId)
        .maybeSingle();
      if (cancelled) return;
      setStream((data as Stream) ?? null);
      setLoaded(true);
    }
    load();

    const ch = supabase
      .channel(`live-stream-${streamId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "live_streams", filter: `id=eq.${streamId}` },
        (payload) => setStream(payload.new as Stream),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [streamId]);

  if (loaded && !stream) throw notFound();

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-7xl w-full px-6 py-8">
        <Link to="/live" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary mb-3">
          <ChevronLeft className="h-3 w-3" /> All live streams
        </Link>

        {!loaded && <div className="font-mono text-muted-foreground">loading…</div>}

        {stream && (
          <div className="grid lg:grid-cols-[1fr_360px] gap-6">
            <div>
              <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden">
                {stream.hls_url && stream.status === "live" ? (
                  <VideoPlayerV2
                    src={stream.hls_url}
                    autoPlay
                    muted
                    className="w-full h-full"
                    showSourceBadge={false}
                    showTapToUnmute
                    isLive
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground font-mono text-sm">
                    {stream.status === "ended"
                      ? "Stream ended."
                      : stream.status === "starting"
                        ? "Starting soon — waiting for the broadcaster…"
                        : "Waiting for stream URL…"}
                  </div>
                )}
              </div>
              <LiveHeader stream={stream} />
              {stream.description && (
                <p className="mt-2 text-muted-foreground whitespace-pre-wrap">{stream.description}</p>
              )}
              <EmbedRow streamId={stream.id} />
              <SimulcastLinks stream={stream} />
            </div>

            <LiveChat streamId={stream.id} />
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

function LiveHeader({ stream }: { stream: Stream }) {
  const viewers = useLiveViewerCount(stream.id);
  const isLive = stream.status === "live" || stream.status === "starting";
  return (
    <div className="mt-4 flex items-center gap-2 flex-wrap">
      {isLive && (
        <>
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <span className="font-mono text-xs text-red-500 font-bold">LIVE</span>
          <span
            className="inline-flex items-center gap-1 rounded-sm border border-border bg-card px-2 py-0.5 font-mono text-xs text-muted-foreground"
            title="Viewers watching right now"
          >
            <Eye className="h-3 w-3" />
            {viewers.toLocaleString()}
            <span className="sr-only"> viewers</span>
          </span>
        </>
      )}
      {!isLive && (
        <span className="font-mono text-xs text-muted-foreground uppercase">{stream.status}</span>
      )}
      <h1 className="text-2xl font-bold ml-2">{stream.title}</h1>
    </div>
  );
}

function EmbedRow({ streamId }: { streamId: string }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const shareUrl = `${origin}/live/${streamId}`;
  const embedSrc = `${origin}/embed/live/${streamId}?autoplay=1&mute=1`;
  const embedCode = `<iframe src="${embedSrc}" width="640" height="360" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen frameborder="0"></iframe>`;
  return (
    <div className="mt-4 flex flex-wrap gap-2 items-center">
      <span className="font-mono text-xs text-muted-foreground self-center">Share:</span>
      <CopyLinkButton value={shareUrl} label="copy link" ariaLabel="Copy stream link" />
      <button
        type="button"
        onClick={() => copyToClipboard(embedCode, { successMessage: "✅ Embed code copied" })}
        className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-all duration-200 hover:border-primary hover:text-primary active:scale-95"
        aria-label="Copy embed code"
      >
        <Code2 className="h-3.5 w-3.5" /> copy embed
      </button>
    </div>
  );
}

function SimulcastLinks({ stream }: { stream: Stream }) {
  const links = [
    { url: stream.simulcast_youtube_url, label: "YouTube", Icon: Youtube },
    { url: stream.simulcast_twitter_url, label: "X", Icon: Twitter },
    { url: stream.simulcast_facebook_url, label: "Facebook", Icon: Facebook },
  ].filter((l) => l.url);
  if (links.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <span className="font-mono text-xs text-muted-foreground self-center">Also live on:</span>
      {links.map(({ url, label, Icon }) => (
        <a
          key={label}
          href={url!}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-background px-2.5 py-1 font-mono text-xs hover:border-primary hover:text-primary transition-colors"
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </a>
      ))}
    </div>
  );
}
