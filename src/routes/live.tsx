import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { VideoPlayerV2 } from "@/components/VideoPlayerV2";
import { LiveChat } from "@/components/LiveChat";
import { Radio, Youtube, Twitter, Facebook, Eye } from "lucide-react";
import { useLiveViewerCount } from "@/hooks/useLiveViewerCount";

export const Route = createFileRoute("/live")({
  head: () => ({
    meta: [
      { title: "Live — streamTXC" },
      {
        name: "description",
        content:
          "Watch live broadcasts on streamTXC. Every stream is auto-archived and stamped on the TEXITcoin chain when it ends.",
      },
      { property: "og:title", content: "Live on streamTXC" },
      { property: "og:description", content: "Watch live streams on streamTXC — auto-archived and on-chain." },
      { property: "og:url", content: "https://streamtxc.com/live" },
      { property: "og:type", content: "video.other" },
    ],
    links: [{ rel: "canonical", href: "https://streamtxc.com/live" }],
  }),
  component: LivePage,
});

interface Stream {
  id: string;
  title: string;
  description: string | null;
  thumbnail_cid: string | null;
  hls_url: string | null;
  status: string;
  started_at: string | null;
  simulcast_youtube_url: string | null;
  simulcast_twitter_url: string | null;
  simulcast_facebook_url: string | null;
  owner_wallet: string;
}

function LivePage() {
  const [stream, setStream] = useState<Stream | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [recent, setRecent] = useState<Stream[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const { data: active } = await supabase
        .from("live_streams")
        .select("*")
        .in("status", ["starting", "live"])
        .order("started_at", { ascending: false, nullsFirst: false })
        .limit(1);
      const { data: past } = await supabase
        .from("live_streams")
        .select("*")
        .in("status", ["ended", "archived"])
        .order("ended_at", { ascending: false, nullsFirst: false })
        .limit(10);
      if (cancelled) return;
      setStream(((active ?? [])[0] as Stream) ?? null);
      setRecent((past ?? []) as Stream[]);
      setLoaded(true);
    }
    refresh();

    const ch = supabase
      .channel("live-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "live_streams" },
        () => refresh(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-7xl w-full px-6 py-8">
        <div className="font-mono text-xs text-primary mb-2">[ LIVE ]</div>

        {!loaded && (
          <div className="font-mono text-muted-foreground">loading…</div>
        )}

        {loaded && !stream && (
          <div className="border border-border rounded-sm p-12 bg-card text-center">
            <Radio className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <h1 className="text-2xl font-bold mb-2">Nothing live right now</h1>
            <p className="text-muted-foreground font-mono text-sm">
              Check back soon — this page will auto-update the moment a stream goes live.
            </p>
          </div>
        )}

        {loaded && stream && (
          <>
            <div className="grid lg:grid-cols-[1fr_360px] gap-6">
              <div>
                <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden">
                  {stream.hls_url ? (
                    <VideoPlayerV2
                      src={stream.hls_url}
                      autoPlay
                      muted
                      className="w-full h-full"
                      showSourceBadge={false}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground font-mono text-sm">
                      Waiting for stream URL…
                    </div>
                  )}
                </div>
                <LiveHeader stream={stream} />
                {stream.description && (
                  <p className="mt-2 text-muted-foreground whitespace-pre-wrap">
                    {stream.description}
                  </p>
                )}

                <SimulcastLinks stream={stream} />
              </div>

              <LiveChat streamId={stream.id} />
            </div>
          </>
        )}

        {recent.length > 0 && (
          <section className="mt-16">
            <div className="font-mono text-xs text-primary mb-3">[ PAST STREAMS ]</div>
            <ul className="space-y-2">
              {recent.map((s) => (
                <li
                  key={s.id}
                  className="border border-border rounded-sm p-3 bg-card flex items-center justify-between gap-4"
                >
                  <div>
                    <div className="font-medium">{s.title}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {s.status} · {new Date(s.started_at ?? "").toLocaleString()}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <Footer />
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

function LiveHeader({ stream }: { stream: Stream }) {
  const viewers = useLiveViewerCount(stream.id);
  return (
    <div className="mt-4 flex items-center gap-2 flex-wrap">
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
      <h1 className="text-2xl font-bold ml-2">{stream.title}</h1>
    </div>
  );
}