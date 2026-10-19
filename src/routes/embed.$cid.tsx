import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { VideoPlayerV2 } from "@/components/VideoPlayerV2";
import { getVideo } from "@/lib/videos.functions";
import { hlsUrlForVideo, ipfsThumbUrl } from "@/lib/ipfs-gateway";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/embed/$cid")({
  head: () => ({ meta: pageMeta("Video player — streamTXC", "Watch an embedded streamTXC video, hosted on IPFS.") }),
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
  const fetchVideo = useServerFn(getVideo);

  // Poll until HLS renditions exist so freshly-uploaded videos upgrade
  // from the raw original to adaptive HLS without a manual reload.
  const { data: video } = useQuery({
    queryKey: ["embed-video", cid],
    queryFn: () => fetchVideo({ data: { cid } }),
    refetchInterval: (q) => (q.state.data?.hls_cid ? false : 15_000),
  });

  const hlsUrl = hlsUrlForVideo(video);
  const src = hlsUrl ?? `/api/stream/${cid}`;

  return (
    <div className="w-screen h-screen bg-black">
      <VideoPlayerV2
        src={src}
        poster={ipfsThumbUrl(video?.thumbnail_cid)}
        captionsSrc={
          video?.transcript_cid
            ? `/api/stream/${video.transcript_cid}`
            : undefined
        }
        autoPlay={autoplay}
        muted={mute || autoplay}
        startAt={t}
        showSourceBadge={false}
        showTapToUnmute={autoplay}
        className="w-full h-full"
      />
    </div>
  );
}