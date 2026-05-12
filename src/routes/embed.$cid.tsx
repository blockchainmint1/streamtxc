import { createFileRoute } from "@tanstack/react-router";
import { VideoPlayer } from "@/components/VideoPlayer";

export const Route = createFileRoute("/embed/$cid")({
  component: EmbedPage,
  validateSearch: (s: Record<string, unknown>) => ({
    autoplay: s.autoplay === "1" || s.autoplay === 1,
    mute: s.mute === "1" || s.mute === 1,
    t: typeof s.t === "string" ? Number(s.t) : Number(s.t ?? 0) || 0,
  }),
});

function EmbedPage() {
  const { cid } = Route.useParams();
  const { autoplay, mute, t } = Route.useSearch();
  return (
    <div className="w-screen h-screen bg-black">
      <VideoPlayer
        src={`/api/stream/${cid}`}
        autoPlay={autoplay}
        muted={mute || autoplay}
        startAt={t}
        className="w-full h-full"
      />
    </div>
  );
}