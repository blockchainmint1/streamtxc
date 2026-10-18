import { useLiveFeedFresh } from "@/lib/use-live-fresh";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { VideoPlayerV2 } from "@/components/VideoPlayerV2";

export const Route = createFileRoute("/embed/live/$streamId")({
  component: LiveEmbedPage,
  validateSearch: (s: Record<string, unknown>) => ({
    autoplay: s.autoplay === "1" || s.autoplay === 1,
    mute: s.mute === "1" || s.mute === 1 || s.muted === "1",
  }),
});

interface StreamRow {
  id: string;
  title: string;
  hls_url: string | null;
  status: string;
}

function LiveEmbedPage() {
  const { streamId } = Route.useParams();
  const { autoplay, mute } = Route.useSearch();
  const [stream, setStream] = useState<StreamRow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from("live_streams")
        .select("id,title,hls_url,status")
        .eq("id", streamId)
        .maybeSingle();
      if (cancelled) return;
      setStream((data as StreamRow) ?? null);
      setLoaded(true);
    }
    load();
    const ch = supabase
      .channel(`embed-live-${streamId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "live_streams", filter: `id=eq.${streamId}` },
        (payload) => setStream(payload.new as StreamRow),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [streamId]);

  const feedFresh = useLiveFeedFresh(stream?.id, stream?.status === "live");
  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center">
      {!loaded && <div className="text-white/60 font-mono text-sm">loading…</div>}
      {loaded && !stream && (
        <div className="text-white/60 font-mono text-sm">Stream not found</div>
      )}
      {stream && stream.hls_url && stream.status === "live" && feedFresh ? (
        <VideoPlayerV2
          src={stream.hls_url}
          autoPlay={autoplay}
          muted={mute || autoplay}
          className="w-full h-full"
          showSourceBadge={false}
          showTapToUnmute
          isLive
        />
      ) : stream ? (
        <div className="text-white/60 font-mono text-sm text-center px-4">
          {stream.status === "ended"
            ? "Stream has ended"
            : stream.status === "starting"
              ? "Starting soon…"
              : "Waiting for stream…"}
        </div>
      ) : null}
    </div>
  );
}