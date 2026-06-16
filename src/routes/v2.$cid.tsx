import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { VideoPlayerV2 } from "@/components/VideoPlayerV2";
import { Button } from "@/components/ui/button";
import { getVideo } from "@/lib/videos.functions";
import { getTranscodeStatus } from "@/lib/transcode.functions";
import { ipfsThumbUrl, ipfsHlsUrl } from "@/lib/ipfs-gateway";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Clock,
  Layers,
} from "lucide-react";
import { formatBytes, formatDate } from "@/lib/fees";

const v2Search = z.object({
  // Override the HLS directory CID (skip DB lookup of hls_cid).
  hls: z.string().min(10).optional().catch(undefined),
  // Override the playlist filename within that directory.
  // Defaults to "master.m3u8" when omitted.
  playlist: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/v2/$cid")({
  validateSearch: zodValidator(v2Search),
  loader: async ({ params }) => {
    try {
      const video = await getVideo({ data: { cid: params.cid } });
      return { video };
    } catch {
      return { video: null };
    }
  },
  head: ({ loaderData, params }) => {
    const v = loaderData?.video;
    return {
      meta: [
        { title: v ? `${v.title} · streamTXC v2` : "v2 player · streamTXC" },
        { name: "robots", content: "noindex" },
      ],
      links: [{ rel: "canonical", href: `https://streamtxc.com/v/${params.cid}` }],
    };
  },
  component: V2WatchPage,
});

function V2WatchPage() {
  const { cid } = Route.useParams();
  const { hls: hlsOverride, playlist: playlistOverride } = Route.useSearch();
  const fetchVideo = useServerFn(getVideo);
  const fetchStatus = useServerFn(getTranscodeStatus);

  const { data: video, isLoading } = useQuery({
    queryKey: ["video", cid],
    queryFn: () => fetchVideo({ data: { cid } }),
  });

  const { data: tx } = useQuery({
    queryKey: ["transcode-status", cid],
    queryFn: () => fetchStatus({ data: { cid } }),
    enabled: !hlsOverride, // skip polling when manually overriding
    refetchInterval: (q) =>
      q.state.data?.transcode_status === "complete" ||
      q.state.data?.transcode_status === "ready" ||
      q.state.data?.transcode_status === "failed" ||
      !q.state.data?.transcode_status
        ? false
        : 5_000,
  });

  // Manual override path: any CID in the URL is acceptable as a routing
  // placeholder; the override drives playback. Lets us smoke-test HLS
  // directories that aren't in the DB yet.
  if (hlsOverride) {
    const streamUrl = `/api/stream/${hlsOverride}/${playlistOverride ?? "master.m3u8"}`;
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="mx-auto w-full max-w-6xl px-6 py-8 flex-1 space-y-6">
          <div className="space-y-1">
            <div className="font-mono text-xs text-amber-500">
              [ V2 PLAYER · MANUAL OVERRIDE · NOT FROM DB ]
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              HLS preview
            </h1>
          </div>
          <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden">
            <VideoPlayerV2 src={streamUrl} />
          </div>
          <div className="border border-border rounded-sm p-4 font-mono text-xs text-muted-foreground space-y-1">
            <div className="text-primary mb-2">[ OVERRIDE SOURCE ]</div>
            <div>hls cid &nbsp;&nbsp;{hlsOverride}</div>
            <div>playlist &nbsp;{playlistOverride ?? "master.m3u8 (default)"}</div>
            <div>stream &nbsp;&nbsp;&nbsp;{streamUrl}</div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

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
          <Link to="/"><Button variant="outline">Go home</Button></Link>
        </div>
      </div>
    );
  }

  const hlsUrl = ipfsHlsUrl(video.hls_cid, video.cid);
  const streamUrl = hlsUrl ?? `/api/stream/${video.cid}`;
  const status = tx?.transcode_status ?? video.transcode_status ?? null;
  const renditions = (tx?.renditions ?? video.renditions ?? null) as
    | { height: number | null; playlist: string }[]
    | null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 py-8 flex-1 space-y-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="font-mono text-xs text-primary">
              [ V2 PLAYER · EXPERIMENTAL ]
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{video.title}</h1>
          </div>
          <Link to="/v/$cid" params={{ cid: video.cid }}>
            <Button variant="outline" size="sm" className="font-mono">
              <ArrowLeft className="mr-2 h-3 w-3" /> back to /v/{video.cid.slice(0, 8)}…
            </Button>
          </Link>
        </div>

        <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden">
          <VideoPlayerV2
            src={streamUrl}
            poster={ipfsThumbUrl(video.thumbnail_cid)}
          />
        </div>

        {video.description && (
          <p className="text-muted-foreground whitespace-pre-wrap">
            {video.description}
          </p>
        )}

        <TranscodeDevPanel
          status={status}
          hlsCid={tx?.hls_cid ?? video.hls_cid ?? null}
          jobId={tx?.transcode_job_id ?? video.transcode_job_id ?? null}
          error={tx?.transcode_error ?? video.transcode_error ?? null}
          startedAt={video.transcode_started_at ?? null}
          completedAt={video.transcode_completed_at ?? null}
          renditions={renditions}
          sizeBytes={video.size_bytes}
          createdAt={video.created_at}
          cid={video.cid}
        />

        <div className="border border-border rounded-sm p-4 font-mono text-xs text-muted-foreground space-y-1">
          <div className="text-primary mb-2">[ KEYBOARD SHORTCUTS ]</div>
          <div>space / k — play/pause</div>
          <div>← / → — seek 5s · j / l — seek 10s · 0-9 — seek to %</div>
          <div>m — mute · f — fullscreen</div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function TranscodeDevPanel({
  status,
  hlsCid,
  jobId,
  error,
  startedAt,
  completedAt,
  renditions,
  sizeBytes,
  createdAt,
  cid,
}: {
  status: string | null;
  hlsCid: string | null;
  jobId: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  renditions: { height: number | null; playlist: string }[] | null;
  sizeBytes: number;
  createdAt: string;
  cid: string;
}) {
  const icon =
    status === "complete" || status === "ready" ? (
      <CheckCircle2 className="h-4 w-4 text-primary" />
    ) : status === "failed" ? (
      <AlertTriangle className="h-4 w-4 text-destructive" />
    ) : status === "processing" || status === "pending" ? (
      <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
    ) : (
      <Clock className="h-4 w-4 text-muted-foreground" />
    );

  const label =
    status === "complete" || status === "ready"
      ? "HLS ready · multi-bitrate streaming active"
      : status === "processing"
      ? "Transcoding on MediaConvert…"
      : status === "pending"
      ? "Queued for transcoding"
      : status === "failed"
      ? "Transcode failed"
      : "Legacy single-MP4 (no transcode record)";

  return (
    <div className="border border-border rounded-sm">
      <div className="px-4 py-3 border-b border-border bg-card font-mono text-xs text-primary flex items-center gap-2">
        <Layers className="h-3 w-3" /> [ TRANSCODE PIPELINE ]
      </div>
      <div className="p-4 space-y-3 font-mono text-xs">
        <div className="flex items-center gap-2 text-sm">
          {icon}
          <span className={status === "failed" ? "text-destructive" : ""}>
            {label}
          </span>
        </div>
        {error && (
          <div className="text-destructive border border-destructive/40 bg-destructive/5 rounded-sm p-2 whitespace-pre-wrap">
            {error}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-muted-foreground">
          <Row k="CID (original)" v={cid} />
          <Row k="HLS CID (directory)" v={hlsCid ?? "—"} />
          <Row k="MediaConvert job" v={jobId ?? "—"} />
          <Row k="Size" v={formatBytes(sizeBytes)} />
          <Row k="Uploaded" v={formatDate(createdAt)} />
          <Row k="Transcode started" v={startedAt ? formatDate(startedAt) : "—"} />
          <Row k="Transcode completed" v={completedAt ? formatDate(completedAt) : "—"} />
        </div>
        {renditions && renditions.length > 0 && (
          <div className="pt-2 border-t border-border">
            <div className="text-muted-foreground mb-1">RENDITIONS</div>
            <ul className="space-y-0.5">
              {renditions.map((r) => (
                <li key={r.playlist} className="text-foreground">
                  {r.height ? `${r.height}p` : "?"} · {r.playlist}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0">{k}</span>
      <span className="text-foreground truncate text-right">{v}</span>
    </div>
  );
}