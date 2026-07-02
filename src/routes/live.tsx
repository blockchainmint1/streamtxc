import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Radio, Eye } from "lucide-react";
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
  owner_wallet: string;
}

function LivePage() {
  const [active, setActive] = useState<Stream[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [recent, setRecent] = useState<Stream[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const { data: activeRows } = await supabase
        .from("live_streams")
        .select("id,title,description,thumbnail_cid,hls_url,status,started_at,owner_wallet")
        .in("status", ["starting", "live"])
        .order("started_at", { ascending: false, nullsFirst: false });
      const { data: past } = await supabase
        .from("live_streams")
        .select("id,title,description,thumbnail_cid,hls_url,status,started_at,owner_wallet")
        .in("status", ["ended", "archived"])
        .order("ended_at", { ascending: false, nullsFirst: false })
        .limit(10);
      if (cancelled) return;
      setActive((activeRows ?? []) as Stream[]);
      setRecent((past ?? []) as Stream[]);
      setLoaded(true);
    }
    refresh();

    const ch = supabase
      .channel("live-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "live_streams" }, () => refresh())
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

        {!loaded && <div className="font-mono text-muted-foreground">loading…</div>}

        {loaded && active.length === 0 && (
          <div className="border border-border rounded-sm p-12 bg-card text-center">
            <Radio className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <h1 className="text-2xl font-bold mb-2">Nothing live right now</h1>
            <p className="text-muted-foreground font-mono text-sm">
              Check back soon — this page will auto-update the moment a stream goes live.
            </p>
          </div>
        )}

        {loaded && active.length > 0 && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {active.map((s) => <LiveCard key={s.id} stream={s} />)}
          </div>
        )}

        {recent.length > 0 && (
          <section className="mt-16">
            <div className="font-mono text-xs text-primary mb-3">[ PAST STREAMS ]</div>
            <ul className="space-y-2">
              {recent.map((s) => (
                <li key={s.id} className="border border-border rounded-sm p-3 bg-card flex items-center justify-between gap-4">
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

function LiveCard({ stream }: { stream: Stream }) {
  const viewers = useLiveViewerCount(stream.id);
  const thumb = stream.thumbnail_cid ? `/api/stream/${stream.thumbnail_cid}` : null;
  return (
    <Link
      to="/live/$streamId"
      params={{ streamId: stream.id }}
      className="group border border-border rounded-sm bg-card overflow-hidden hover:border-primary transition-colors"
    >
      <div className="aspect-video bg-black relative">
        {thumb ? (
          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <Radio className="h-8 w-8" />
          </div>
        )}
        <div className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-sm bg-red-500/95 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-white opacity-75 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
          </span>
          LIVE
        </div>
        <div className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-sm bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
          <Eye className="h-3 w-3" />
          {viewers.toLocaleString()}
        </div>
      </div>
      <div className="p-3">
        <div className="font-medium truncate group-hover:text-primary">{stream.title}</div>
        {stream.description && (
          <div className="text-xs text-muted-foreground line-clamp-2 mt-1">{stream.description}</div>
        )}
      </div>
    </Link>
  );
}
