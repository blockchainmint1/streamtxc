import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { VideoPlayerV2 } from "@/components/VideoPlayerV2";
import { getLiveStreamByWallet } from "@/lib/live-by-wallet.functions";

export const Route = createFileRoute("/embed/live/by-wallet/$wallet")({
  component: EmbedByWallet,
  validateSearch: (s: Record<string, unknown>) => ({
    autoplay: s.autoplay === "1" || s.autoplay === 1,
    mute: s.mute === "1" || s.mute === 1 || s.muted === "1",
  }),
});

function EmbedByWallet() {
  const { wallet } = Route.useParams();
  const { autoplay, mute } = Route.useSearch();
  const lookup = useServerFn(getLiveStreamByWallet);

  const q = useQuery({
    queryKey: ["live-by-wallet", wallet],
    queryFn: () => lookup({ data: { wallet } }),
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
  });

  const stream = q.data?.stream ?? null;

  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center">
      {q.isLoading && (
        <div className="text-white/60 font-mono text-sm">loading…</div>
      )}
      {!q.isLoading && stream && stream.hls_url ? (
        <VideoPlayerV2
          src={stream.hls_url}
          autoPlay={autoplay}
          muted={mute || autoplay}
          className="w-full h-full"
          showSourceBadge={false}
          showTapToUnmute
          isLive
        />
      ) : !q.isLoading ? (
        <div className="text-center px-4">
          <div className="text-white/70 font-mono text-sm mb-1">Offline</div>
          <div className="text-white/40 font-mono text-xs">
            Next stream coming soon
          </div>
        </div>
      ) : null}
    </div>
  );
}