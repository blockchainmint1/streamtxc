import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { VideoPlayer } from "@/components/VideoPlayer";
import { Button } from "@/components/ui/button";
import {
  getVideo,
  pollTxStatus,
  reportVideo,
  probeAvailability,
  restoreOneFromIpfs,
} from "@/lib/videos.functions";
import {
  formatBytes,
  formatTxc,
  formatDate,
  PAYMENT_GRACE_HOURS,
  PAYMENT_DUST_TXC,
} from "@/lib/fees";
import { shortWalletId } from "@/lib/wallet";
import {
  Copy,
  ExternalLink,
  Eye,
  Calendar,
  Hash,
  Check,
  Code2,
  Loader2,
  CheckCircle2,
  Wallet,
  AlertTriangle,
  Flag,
  ShieldAlert,
  QrCode,
  ChevronDown,
  Share2,
  Twitter,
  Facebook,
  Send,
  MessageCircle,
  Link as LinkIcon,
  CloudOff,
  RefreshCw,
  Upload as UploadIcon,
} from "lucide-react";
import { useWallet } from "@/lib/wallet";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { QRCodeSVG } from "qrcode.react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Comments } from "@/components/Comments";
import { ipfsThumbUrl, ipfsHlsUrl } from "@/lib/ipfs-gateway";

export const Route = createFileRoute("/v/$cid")({
  loader: async ({ params }) => {
    // Fetch the video server-side so social-media scrapers (Telegram,
    // Twitter, Facebook, Discord, iMessage) get a per-video og:image and
    // title in the SSR'd HTML — they don't run client JS, so a useQuery
    // alone can't populate share previews.
    try {
      const video = await getVideo({ data: { cid: params.cid } });
      return { video };
    } catch {
      return { video: null };
    }
  },
  head: ({ loaderData, params }) => {
    const video = loaderData?.video;
    const SITE = "https://streamtxc.com";
    if (!video) {
      return { meta: [{ title: "Video not found · streamTXC" }] };
    }
    const title = `${video.title} · streamTXC`;
    const description =
      (video.description?.trim() ||
        "TEXITcoin-stamped video on streamTXC — proof of ownership on IPFS.").slice(0, 280);
    const pageUrl = `${SITE}/v/${params.cid}`;
    const image = video.thumbnail_cid
      ? `${SITE}/api/stream/${video.thumbnail_cid}`
      : null;
    const meta: Array<Record<string, string>> = [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "video.other" },
      { property: "og:url", content: pageUrl },
      { name: "twitter:card", content: image ? "summary_large_image" : "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ];
    if (image) {
      meta.push(
        { property: "og:image", content: image },
        { property: "og:image:alt", content: video.title },
        { name: "twitter:image", content: image },
        { property: "og:video", content: `${SITE}/api/stream/${params.cid}` },
        { property: "og:video:url", content: `${SITE}/api/stream/${params.cid}` },
        { property: "og:video:secure_url", content: `${SITE}/api/stream/${params.cid}` },
        { property: "og:video:type", content: "video/mp4" },
      );
    }
    return {
      meta,
      links: [{ rel: "canonical", href: pageUrl }],
    };
  },
  component: WatchPage,
});

function WatchPage() {
  const { cid } = Route.useParams();
  const navigate = useNavigate();
  const { address } = useWallet();
  const fetchVideo = useServerFn(getVideo);
  const pollTx = useServerFn(pollTxStatus);
  const probe = useServerFn(probeAvailability);
  const restoreOne = useServerFn(restoreOneFromIpfs);
  const { data: video, isLoading } = useQuery({
    queryKey: ["video", cid],
    queryFn: () => fetchVideo({ data: { cid } }),
  });

  // Poll on-chain confirmation while still in mempool. Once confirmed the
  // server fn updates the row and returns status='active', so we stop polling.
  const { data: chain } = useQuery({
    queryKey: ["tx-status", cid],
    queryFn: () => pollTx({ data: { cid } }),
    enabled: !!video,
    refetchInterval: (q) =>
      q.state.data?.status === "active" ? false : 15_000,
  });

  const status = chain?.status ?? video?.status;
  const blockNumber = chain?.blockNumber ?? video?.block_number ?? null;
  const blockHash = chain?.blockHash ?? video?.block_hash ?? null;
  const txHash = chain?.txHash ?? video?.tx_hash ?? null;
  const confirmed = status === "active" && !!blockNumber;
  const stampFailed = status === "stamp_failed";

  // Live availability — true when bytes can be served from our gateway
  // and the row isn't flagged as unpinned. Runs after `getVideo` resolves
  // and won't block first paint.
  const { data: avail, refetch: refetchAvail } = useQuery({
    queryKey: ["video-availability", cid],
    queryFn: () => probe({ data: { cid } }),
    enabled: !!video,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const unavailable = !!avail && !avail.available;
  const isOwner =
    !!address &&
    !!video?.owner_wallet &&
    address.toLowerCase() === video.owner_wallet.toLowerCase();
  const [restoring, setRestoring] = useState(false);

  const handleRestoreFromIpfs = async () => {
    setRestoring(true);
    try {
      const res = await restoreOne({ data: { cid } });
      if (res.ok) {
        toast.success(
          "Asked Pinata to re-fetch from IPFS. Re-checking in 10s…",
        );
        setTimeout(() => void refetchAvail(), 10_000);
      } else {
        toast.error(res.error || "Restore request failed.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  };

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

  // Prefer the adaptive HLS bundle when it's ready; fall back to the legacy
  // single-MP4 stream for older videos or while transcoding is in progress.
  const hlsUrl = ipfsHlsUrl(video.hls_cid, video.cid);
  const streamUrl = hlsUrl ?? `/api/stream/${video.cid}`;
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const embedSrc = `${origin}/embed/${video.cid}?${new URLSearchParams({
    ...(autoplay ? { autoplay: "1" } : {}),
    ...(muted ? { mute: "1" } : {}),
    ...(startAt ? { t: String(startAt) } : {}),
  }).toString()}`;
  const embedCode = `<iframe src="${embedSrc}" width="${embedW}" height="${embedH}" allow="autoplay; fullscreen" frameborder="0"></iframe>`;

  const copy = (text: string) => {
    void copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 py-8 flex-1">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Player + meta */}
          <div className="lg:col-span-2 space-y-4">
            {unavailable ? (
              <div className="aspect-video bg-black border-2 border-destructive/60 rounded-sm overflow-hidden relative">
                {video.thumbnail_cid && (
                  <img
                    src={ipfsThumbUrl(video.thumbnail_cid)}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover grayscale opacity-30"
                  />
                )}
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 gap-3 bg-background/40">
                  <CloudOff className="h-10 w-10 text-destructive" />
                  <div className="font-mono text-xs text-destructive uppercase tracking-wider">
                    [ NO LONGER ON IPFS ]
                  </div>
                  <p className="text-sm text-foreground max-w-md">
                    Our pinning node released this file (hosting prepayment
                    expired) and no other peer is currently seeding it. The
                    on-chain record is permanent — the bytes just aren't
                    being served right now.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center mt-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleRestoreFromIpfs}
                      disabled={restoring}
                      className="font-mono text-xs"
                    >
                      <RefreshCw className={`mr-2 h-3.5 w-3.5 ${restoring ? "animate-spin" : ""}`} />
                      {restoring ? "asking peers…" : "try restore from peers"}
                    </Button>
                    {isOwner && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          navigate({
                            to: "/v/$cid/restore",
                            params: { cid: video.cid },
                          })
                        }
                        className="font-mono text-xs"
                      >
                        <UploadIcon className="mr-2 h-3.5 w-3.5" />
                        re-seed from original file
                      </Button>
                    )}
                    <a
                      href={`https://ipfs.io/ipfs/${video.cid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-primary px-3 py-1.5"
                    >
                      <ExternalLink className="h-3 w-3" />
                      check ipfs.io
                    </a>
                  </div>
                  {!isOwner && video.owner_wallet && (
                    <p className="font-mono text-[11px] text-muted-foreground mt-2">
                      Only the original uploader (
                      <Link
                        to="/u/$wallet"
                        params={{ wallet: video.owner_wallet }}
                        className="text-primary hover:underline"
                      >
                        {shortWalletId(video.owner_wallet)}
                      </Link>
                      ) can re-seed the original file.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden relative">
                <VideoPlayer
                  src={streamUrl}
                  poster={ipfsThumbUrl(video.thumbnail_cid)}
                />
                <LargeFileWarmupOverlay
                  sizeBytes={video.size_bytes}
                  createdAt={video.created_at}
                />
                <ExpiringSoonOverlay
                  expiresAt={video.expires_at}
                  paymentRequired={Number(video.payment_required_txc ?? 0)}
                  paymentReceived={Number(video.payment_received_txc ?? 0)}
                  unpinnedAt={video.unpinned_at ?? null}
                />
              </div>
            )}
            <h1 className="text-2xl font-bold tracking-tight">{video.title}</h1>
            {video.description && (
              <p className="text-muted-foreground whitespace-pre-wrap">
                {video.description}
              </p>
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
            <ShareBar
              title={video.title}
              url={origin ? `${origin}/v/${video.cid}` : `/v/${video.cid}`}
              onCopy={copy}
            />
          </div>

          {/* Sidebar: chain info + embed */}
          <div className="space-y-4">
            <CollapsibleSection title="[ ON-CHAIN PROOF ]" defaultOpen={true}>
              <Field label="IPFS CID" value={video.cid} onCopy={copy} mono />
              {video.video_wallet && (
                <Field
                  label="Video wallet (full chain history)"
                  value={video.video_wallet}
                  href={`https://mempool.texitcoin.org/address/${video.video_wallet}`}
                  onCopy={copy}
                  mono
                />
              )}
              {txHash && (
                <Field
                  label="Claim tx hash"
                  value={txHash}
                  href={`https://mempool.texitcoin.org/tx/${txHash}`}
                  onCopy={copy}
                  mono
                />
              )}
              <div>
                <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
                  Confirmation
                </div>
                {confirmed ? (
                  <div className="flex items-center gap-1.5 text-xs mt-0.5 text-primary font-mono">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    confirmed in block #{blockNumber}
                  </div>
                ) : stampFailed ? (
                  <div className="text-xs mt-0.5 text-destructive font-mono">
                    chain stamp failed — not in mempool yet
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs mt-0.5 text-muted-foreground font-mono">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    pending — in mempool
                  </div>
                )}
              </div>
              {blockHash && (
                <Field label="Block hash" value={blockHash} onCopy={copy} mono />
              )}
              {video.op_return_payload && (
                <Field
                  label="OP_RETURN data"
                  value={video.op_return_payload}
                  onCopy={copy}
                  mono
                />
              )}
              {video.metadata_cid && (
                <Field
                  label="Metadata CID (title + description, on IPFS)"
                  value={video.metadata_cid}
                  href={`https://${
                    import.meta.env.VITE_PINATA_GATEWAY_DOMAIN ||
                    "gateway.pinata.cloud"
                  }/ipfs/${video.metadata_cid}`}
                  onCopy={copy}
                  mono
                />
              )}
              <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider pt-2 border-t border-border">
                TXC PROOF IS PERMANENT — DOES NOT EXPIRE.
              </p>
            </CollapsibleSection>
            {video.video_wallet && video.payment_required_txc != null && (
              <div id="hosting-payment" className="scroll-mt-24">
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
              </div>
            )}

            <CollapsibleSection
              title="[ EMBED ]"
              icon={<Code2 className="h-3.5 w-3.5" />}
              defaultOpen={false}
            >
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
            </CollapsibleSection>
          </div>
        </div>
        <Comments cid={video.cid} />
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

function ShareBar({
  title,
  url,
  onCopy,
}: {
  title: string;
  url: string;
  onCopy: (s: string) => void;
}) {
  const text = `${title} — on-chain proof video`;
  const enc = encodeURIComponent;
  const links = [
    {
      name: "X",
      icon: Twitter,
      href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`,
    },
    {
      name: "Facebook",
      icon: Facebook,
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    },
    {
      name: "Reddit",
      icon: MessageCircle,
      href: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(title)}`,
    },
    {
      name: "Telegram",
      icon: Send,
      href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`,
    },
  ];
  const nativeShare = async () => {
    if (typeof navigator !== "undefined" && (navigator as Navigator & { share?: (d: ShareData) => Promise<void> }).share) {
      try {
        await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({ title, text, url });
      } catch {
        // user cancelled
      }
    } else {
      onCopy(url);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
        share
      </span>
      {links.map((l) => (
        <a
          key={l.name}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Share on ${l.name}`}
          className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <l.icon className="h-3.5 w-3.5" />
          {l.name}
        </a>
      ))}
      <CopyLinkButton
        value={url}
        icon={<LinkIcon className="h-3.5 w-3.5" />}
      />
      <button
        onClick={nativeShare}
        className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        aria-label="More share options"
      >
        <Share2 className="h-3.5 w-3.5" />
        more
      </button>
    </div>
  );
}

function PaymentPanel({
  required,
  received,
  wallet,
  paidAt,
  createdAt,
  expiresAt,
  monthsPrepaid,
  onCopy,
}: {
  required: number;
  received: number;
  wallet: string;
  paidAt: string | null;
  createdAt: string;
  expiresAt: string;
  monthsPrepaid: number;
  onCopy: (s: string) => void;
}) {
  // Filter out platform stamp dust so it doesn't masquerade as a partial user payment.
  const effectiveReceived = received >= PAYMENT_DUST_TXC ? received : 0;
  const paid = paidAt != null || effectiveReceived >= required;
  const partial = !paid && effectiveReceived > 0;
  const remaining = Math.max(0, +(required - effectiveReceived).toFixed(8));
  const ageHrs = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  const graceLeft = Math.max(0, PAYMENT_GRACE_HOURS - ageHrs);
  const [showQr, setShowQr] = useState(false);
  const monthlyRate = monthsPrepaid > 0 ? required / monthsPrepaid : required;
  // BIP-21 style URI so wallet apps that scan can pre-fill the amount.
  const qrPayload =
    remaining > 0
      ? `texitcoin:${wallet}?amount=${remaining}`
      : `texitcoin:${wallet}`;

  return (
    <>
      {paid ? (
        <>
          <div className="flex items-center gap-1.5 text-xs text-primary font-mono">
            <CheckCircle2 className="h-3.5 w-3.5" />
            paid · {formatTxc(effectiveReceived)}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            stays live until{" "}
            <span className="text-foreground">{formatDate(expiresAt)}</span>
            {monthlyRate > 0 && (
              <>
                {" "}· extend life by sending more TXC ({formatTxc(monthlyRate)} ={" "}
                +1 month)
              </>
            )}
          </div>
          <div>
            <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              top-up address
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-xs font-mono bg-input border border-border rounded-sm px-2 py-1.5">
                {wallet}
              </code>
              <button
                onClick={() => onCopy(wallet)}
                className="text-muted-foreground hover:text-primary"
                aria-label="Copy address"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setShowQr((v) => !v)}
                className={`transition-colors ${showQr ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
                aria-label="Show QR code"
              >
                <QrCode className="h-3.5 w-3.5" />
              </button>
            </div>
            {showQr && (
              <div className="mt-3 flex flex-col items-center gap-2 bg-white p-3 rounded-sm">
                <QRCodeSVG value={qrPayload} size={180} level="M" marginSize={2} />
                <div className="font-mono text-[10px] text-black text-center break-all">
                  {wallet.slice(0, 12)}…{wallet.slice(-8)}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 font-mono text-xs">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                amount due
              </div>
              <div className="text-primary font-bold">{formatTxc(remaining)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                received
              </div>
              <div>{formatTxc(effectiveReceived)}</div>
            </div>
          </div>
          {partial && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-500 font-mono">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              partial payment received — send the remainder to confirm
            </div>
          )}
          {monthlyRate > 0 && (
            <div className="font-mono text-[11px] text-muted-foreground">
              rate: {formatTxc(monthlyRate)} per month · overpay extends hosting
              automatically
            </div>
          )}
          <div>
            <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              send TXC to
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-xs font-mono bg-input border border-border rounded-sm px-2 py-1.5">
                {wallet}
              </code>
              <button
                onClick={() => onCopy(wallet)}
                className="text-muted-foreground hover:text-primary"
                aria-label="Copy address"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setShowQr((v) => !v)}
                className={`transition-colors ${showQr ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
                aria-label="Show QR code"
              >
                <QrCode className="h-3.5 w-3.5" />
              </button>
            </div>
            {showQr && (
              <div className="mt-3 flex flex-col items-center gap-2 bg-white p-3 rounded-sm">
                <QRCodeSVG
                  value={qrPayload}
                  size={180}
                  level="M"
                  marginSize={2}
                />
                <div className="font-mono text-[10px] text-black text-center break-all">
                  {formatTxc(remaining)} → {wallet.slice(0, 12)}…{wallet.slice(-8)}
                </div>
              </div>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Send exactly the amount above from any TXC wallet. Confirmation is
            automatic — your video stays live as soon as the payment lands.
            Unpaid videos are unpinned after{" "}
            <span className="text-foreground">
              {graceLeft <= 0
                ? "0h"
                : graceLeft >= 48
                  ? `${(graceLeft / 24).toFixed(1)} days`
                  : `${graceLeft.toFixed(1)}h`}
            </span>
            .
          </p>
          <a
            href={`https://mempool.texitcoin.org/address/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline"
          >
            view address on mempool <ExternalLink className="h-3 w-3" />
          </a>
        </>
      )}
    </>
  );
}

function CollapsibleSection({
  title,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border border-border bg-card rounded-sm">
        <CollapsibleTrigger className="w-full flex items-center justify-between p-4 group">
          <h2 className="font-mono text-xs text-primary flex items-center gap-1.5">
            {icon}
            {title}
          </h2>
          <ChevronDown
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-4 space-y-3">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

const REPORT_REASONS: { value: string; label: string }[] = [
  { value: "nsfw", label: "Adult / pornographic content" },
  { value: "csam", label: "Child sexual abuse material" },
  { value: "violence", label: "Graphic violence or gore" },
  { value: "copyright", label: "Copyright / stolen content" },
  { value: "illegal", label: "Other illegal content" },
  { value: "spam", label: "Spam or misleading" },
  { value: "other", label: "Other (explain below)" },
];

function ReportButton({ cid }: { cid: string }) {
  const reportFn = useServerFn(reportVideo);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!reason) {
      toast.error("Pick a reason");
      return;
    }
    setSubmitting(true);
    try {
      const res = await reportFn({
        data: { cid, reason: reason as never, details },
      });
      if (res.alreadyReported) {
        toast("You've already reported this video today");
      } else {
        toast.success("Report received — video is hidden pending review");
      }
      setOpen(false);
      setReason("");
      setDetails("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to report");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="ml-auto flex items-center gap-1.5 text-muted-foreground hover:text-destructive transition-colors"
          aria-label="Report this video"
        >
          <Flag className="h-3.5 w-3.5" />
          report
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Report this video</DialogTitle>
          <DialogDescription>
            Reported videos are immediately hidden from the homepage while a
            moderator reviews them. Abuse of this tool may result in IP-level
            blocks.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="font-mono text-xs">REASON</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a reason" />
              </SelectTrigger>
              <SelectContent>
                {REPORT_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="font-mono text-xs">
              DETAILS (optional)
            </Label>
            <Textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Anything a moderator should know"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={submitting || !reason}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Submitting…
              </>
            ) : (
              <>
                <Flag className="mr-2 h-3 w-3" /> Submit report
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LargeFileWarmupOverlay({
  sizeBytes,
  createdAt,
}: {
  sizeBytes: number;
  createdAt: string;
}) {
  const ageMin = (Date.now() - new Date(createdAt).getTime()) / 60_000;
  const isLarge = sizeBytes >= 200 * 1024 * 1024; // ≥200 MB
  const isFresh = ageMin < 60; // first hour after upload
  const [dismissed, setDismissed] = useState(false);
  if (!isLarge || !isFresh || dismissed) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center p-3">
      <div className="pointer-events-auto max-w-md rounded-sm border border-primary/40 bg-background/90 backdrop-blur px-3 py-2 flex items-start gap-2 shadow-lg">
        <Loader2 className="h-3.5 w-3.5 mt-0.5 text-primary animate-spin shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-primary">
            [ large file · warming up ]
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatBytes(sizeBytes)} just landed on IPFS — first playback can
            take a minute while the gateway pulls and caches it. Give it a
            moment, then hit play.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="font-mono text-[10px] uppercase text-muted-foreground hover:text-foreground px-1"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function ExpiringSoonOverlay({
  expiresAt,
  paymentRequired,
  paymentReceived,
  unpinnedAt,
}: {
  expiresAt: string;
  paymentRequired: number;
  paymentReceived: number;
  unpinnedAt: string | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (unpinnedAt) return null; // already expired — different UI handles this
  if (paymentRequired <= 0) return null;
  if (paymentReceived >= paymentRequired) return null; // already paid
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  const hoursLeft = msLeft / 3_600_000;
  if (hoursLeft > 24 || hoursLeft <= 0) return null;
  if (dismissed) return null;
  const hoursStr =
    hoursLeft >= 1
      ? `${Math.floor(hoursLeft)}h`
      : `${Math.max(1, Math.floor(hoursLeft * 60))}m`;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-10 flex justify-center p-3">
      <div className="pointer-events-auto max-w-md rounded-sm border border-destructive/60 bg-background/95 backdrop-blur px-3 py-2 flex items-start gap-2 shadow-lg">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-destructive shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-destructive">
            [ expires in {hoursStr} ]
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Love this video? Keep it alive with a micropayment — unpaid videos
            get unpinned from IPFS.
          </p>
          <a
            href="#hosting-payment"
            className="inline-block mt-1 font-mono text-[11px] uppercase tracking-wider text-primary hover:underline"
          >
            keep it alive →
          </a>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="font-mono text-[10px] uppercase text-muted-foreground hover:text-foreground px-1"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}