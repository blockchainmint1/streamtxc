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
import { pollTxStatus } from "@/lib/videos.functions";
import { getTranscodeStatus } from "@/lib/transcode.functions";
import { ipfsThumbUrl, ipfsHlsUrl } from "@/lib/ipfs-gateway";
import { CidField } from "@/components/CidField";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { OnChainProofPanel } from "@/components/OnChainProofPanel";
import { PaymentPanel } from "@/components/PaymentPanel";
import { EmbedPanel } from "@/components/EmbedPanel";
import { ShareBar } from "@/components/ShareBar";
import { ReportButton } from "@/components/ReportButton";
import { Comments } from "@/components/Comments";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import {
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Clock,
  Layers,
  Eye,
  Calendar,
  Wallet,
  Code2,
  ShieldAlert,
} from "lucide-react";
import { formatBytes, formatDate, formatDateTime } from "@/lib/fees";
import { shortWalletId } from "@/lib/wallet";

const v2Search = z.object({
  // Override the HLS directory CID (skip DB lookup of hls_cid).
  hls: z.string().min(10).optional().catch(undefined),
  // Override the playlist filename within that directory.
  // Defaults to "master.m3u8" when omitted.
  playlist: z.string().min(1).optional().catch(undefined),
});

export const Route = createFileRoute("/v/$cid")({
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
    const url = `https://streamtxc.com/v/${params.cid}`;
    const title = v ? `${v.title} · streamTXC` : "streamTXC";
    const desc = v?.description
      ? v.description.slice(0, 160)
      : "Watch this content-addressed video on streamTXC — pinned to IPFS, receipted on the TEXITcoin chain.";
    const thumb = v?.thumbnail_cid
      ? `https://ipfs.honest.money/ipfs/${v.thumbnail_cid}`
      : undefined;
    const meta: Array<Record<string, string>> = [
      { title },
      { name: "description", content: desc },
      { property: "og:title", content: title },
      { property: "og:description", content: desc },
      { property: "og:url", content: url },
      { property: "og:type", content: "video.other" },
      { name: "twitter:card", content: thumb ? "summary_large_image" : "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: desc },
    ];
    if (thumb) {
      meta.push({ property: "og:image", content: thumb });
      meta.push({ name: "twitter:image", content: thumb });
    }
    const scripts = v
      ? [
          {
            type: "application/ld+json",
            children: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "VideoObject",
              name: v.title,
              description: desc,
              thumbnailUrl: thumb ? [thumb] : undefined,
              uploadDate: v.created_at,
              contentUrl: `https://streamtxc.com/api/stream/${v.cid}`,
              embedUrl: `https://streamtxc.com/embed/${v.cid}`,
            }),
          },
        ]
      : undefined;
    return {
      meta,
      links: [{ rel: "canonical", href: url }],
      ...(scripts ? { scripts } : {}),
    };
  },
  component: WatchPage,
});

function WatchPage() {
  const { cid } = Route.useParams();
  const { hls: hlsOverride, playlist: playlistOverride } = Route.useSearch();
  const fetchVideo = useServerFn(getVideo);
  const fetchStatus = useServerFn(getTranscodeStatus);
  const pollTx = useServerFn(pollTxStatus);
  const copy = (s: string) => void copyToClipboard(s);

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

  const { data: chain } = useQuery({
    queryKey: ["tx-status", cid],
    queryFn: () => pollTx({ data: { cid } }),
    enabled: !hlsOverride && !!video,
    refetchInterval: (q) =>
      q.state.data?.status === "active" ? false : 15_000,
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
              [ MANUAL OVERRIDE · NOT FROM DB ]
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
  const hlsCid = tx?.hls_cid ?? video.hls_cid ?? null;
  const jobId = tx?.transcode_job_id ?? video.transcode_job_id ?? null;
  const error = tx?.transcode_error ?? video.transcode_error ?? null;

  const chainStatus = chain?.status ?? video.status;
  const blockNumber = chain?.blockNumber ?? video.block_number ?? null;
  const blockHash = chain?.blockHash ?? video.block_hash ?? null;
  const txHash = chain?.txHash ?? video.tx_hash ?? null;
  const confirmed = chainStatus === "active" && !!blockNumber;
  const stampFailed = chainStatus === "stamp_failed";

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const shareUrl = origin ? `${origin}/v/${video.cid}` : `/v/${video.cid}`;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 py-8 flex-1">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Player + meta */}
          <div className="lg:col-span-2 space-y-4">
            <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden">
              <VideoPlayerV2
                src={streamUrl}
                poster={ipfsThumbUrl(video.thumbnail_cid)}
              />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{video.title}</h1>
            {video.description && (
              <p className="text-muted-foreground whitespace-pre-wrap">
                {video.description}
              </p>
            )}
            {(video.transcript_text || video.transcript_cid) && (
              <CollapsibleSection title="[ TRANSCRIPT ]" defaultOpen={false}>
                <div className="space-y-3">
                  {video.transcript_text ? (
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto pr-2">
                      {video.transcript_text}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground font-mono">
                      Transcript is being generated — refresh in a minute.
                    </p>
                  )}
                  {video.transcript_cid && (
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        Source-of-truth WebVTT on IPFS
                      </span>
                      <a
                        href={`https://ipfs.honest.money/ipfs/${video.transcript_cid}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[11px] text-primary hover:underline"
                      >
                        open .vtt →
                      </a>
                    </div>
                  )}
                </div>
              </CollapsibleSection>
            )}
            {video.hidden_at && (
              <div className="border-2 border-amber-500/60 bg-amber-500/5 rounded-sm p-4 flex items-start gap-3">
                <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="font-mono text-xs text-amber-500">
                    [ UNDER REVIEW · HIDDEN FROM HOMEPAGE ]
                  </div>
                  <p className="text-sm text-muted-foreground">
                    This video has been reported and is hidden from public
                    listings while a moderator reviews it. The file remains on
                    IPFS — direct links still work — but it won't appear on the
                    homepage or search until the report is resolved.
                  </p>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-4 font-mono text-xs text-muted-foreground border-t border-border pt-4">
              <span className="flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" /> {video.view_count} views
              </span>
              <span className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {formatDate(video.created_at)}
              </span>
              <span>{formatBytes(video.size_bytes)}</span>
              <span className="flex items-center gap-1">
                uploader:{" "}
                {video.owner_wallet ? (
                  <Link
                    to="/u/$wallet"
                    params={{ wallet: video.owner_wallet }}
                    className="font-mono hover:text-primary transition-colors"
                  >
                    {shortWalletId(video.owner_wallet)}
                  </Link>
                ) : (
                  "anonymous"
                )}
              </span>
              <ReportButton cid={video.cid} />
            </div>
            <ShareBar title={video.title} url={shareUrl} onCopy={copy} />
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <OnChainProofPanel
              cid={video.cid}
              videoWallet={video.video_wallet}
              txHash={txHash}
              blockNumber={blockNumber}
              blockHash={blockHash}
              opReturnPayload={video.op_return_payload}
              metadataCid={video.metadata_cid}
              confirmed={confirmed}
              stampFailed={stampFailed}
              onCopy={copy}
            />

            {video.video_wallet && video.payment_required_txc != null && (
              <CollapsibleSection
                title="[ HOSTING PAYMENT ]"
                icon={<Wallet className="h-3.5 w-3.5" />}
                defaultOpen={!video.paid_at}
              >
                <PaymentPanel
                  required={Number(video.payment_required_txc)}
                  received={Number(video.payment_received_txc ?? 0)}
                  wallet={video.video_wallet}
                  paidAt={video.paid_at ?? null}
                  createdAt={video.created_at}
                  expiresAt={video.expires_at}
                  monthsPrepaid={video.months_prepaid ?? 1}
                  onCopy={copy}
                />
              </CollapsibleSection>
            )}

            <CollapsibleSection
              title="[ EMBED ]"
              icon={<Code2 className="h-3.5 w-3.5" />}
              defaultOpen={false}
            >
              <EmbedPanel cid={video.cid} onCopy={copy} />
            </CollapsibleSection>

            <CollapsibleSection
              title="[ TRANSCODE PIPELINE ]"
              icon={<Layers className="h-3.5 w-3.5" />}
              defaultOpen={false}
            >
              <TranscodeBody
                status={status}
                hlsCid={hlsCid}
                jobId={jobId}
                error={error}
                startedAt={video.transcode_started_at ?? null}
                completedAt={video.transcode_completed_at ?? null}
                renditions={renditions}
                sizeBytes={video.size_bytes}
                createdAt={video.created_at}
                cid={video.cid}
                onCopy={copy}
              />
            </CollapsibleSection>

            <CollapsibleSection title="[ KEYBOARD SHORTCUTS ]" defaultOpen={false}>
              <div className="font-mono text-xs text-muted-foreground space-y-1">
                <div>space / k — play/pause</div>
                <div>← / → — seek 5s · j / l — seek 10s</div>
                <div>0-9 — seek to %</div>
                <div>m — mute · f — fullscreen</div>
              </div>
            </CollapsibleSection>
          </div>
        </div>
        <Comments cid={video.cid} />
      </main>
      <Footer />
    </div>
  );
}

function TranscodeBody({
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
  onCopy,
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
  onCopy: (s: string) => void;
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
    <>
      <div className="flex items-start gap-2 text-sm">
        <span className="shrink-0 mt-0.5">{icon}</span>
        <span className={`font-mono text-xs ${status === "failed" ? "text-destructive" : ""}`}>
          {label}
        </span>
      </div>
      {error && (
        <div className="text-destructive border border-destructive/40 bg-destructive/5 rounded-sm p-2 whitespace-pre-wrap font-mono text-[11px]">
          {error}
        </div>
      )}
      <CidField label="CID (original)" value={cid} onCopy={onCopy} mono />
      <CidField label="HLS CID (directory)" value={hlsCid ?? "—"} onCopy={hlsCid ? onCopy : undefined} mono />
      {jobId && <CidField label="MediaConvert job" value={jobId} onCopy={onCopy} mono />}
      <div className="grid grid-cols-2 gap-3 font-mono text-xs pt-1 border-t border-border">
        <Meta k="Size" v={formatBytes(sizeBytes)} />
        <Meta k="Uploaded" v={formatDateTime(createdAt)} />
        <Meta k="Started" v={startedAt ? formatDateTime(startedAt) : "—"} />
        <Meta k="Completed" v={completedAt ? formatDateTime(completedAt) : "—"} />
      </div>
      {renditions && renditions.length > 0 && (
        <div className="pt-2 border-t border-border font-mono text-xs">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Renditions
          </div>
          <ul className="space-y-0.5">
            {renditions.map((r) => (
              <li key={r.playlist} className="text-foreground break-all">
                {r.height ? `${r.height}p` : "?"} · {r.playlist}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{k}</div>
      <div className="text-foreground break-words">{v}</div>
    </div>
  );
}