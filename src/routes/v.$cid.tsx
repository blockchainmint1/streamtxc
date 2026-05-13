import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { VideoPlayer } from "@/components/VideoPlayer";
import { Button } from "@/components/ui/button";
import { getVideo, pollTxStatus, reportVideo } from "@/lib/videos.functions";
import { formatBytes, formatTxc, formatDate } from "@/lib/fees";
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
} from "lucide-react";
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
import { ipfsThumbUrl } from "@/lib/ipfs-gateway";

export const Route = createFileRoute("/v/$cid")({
  component: WatchPage,
});

function WatchPage() {
  const { cid } = Route.useParams();
  const fetchVideo = useServerFn(getVideo);
  const pollTx = useServerFn(pollTxStatus);
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

  const streamUrl = `/api/stream/${video.cid}`;
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
            <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden">
              <VideoPlayer
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
            <CollapsibleSection title="[ ON-CHAIN PROOF ]" defaultOpen={false}>
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
                TXC proof is permanent — timestamped proof on TXC does not expire.
              </p>
            </CollapsibleSection>

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
  const paid = paidAt != null || received >= required;
  const partial = !paid && received > 0;
  const remaining = Math.max(0, +(required - received).toFixed(8));
  const ageHrs = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  const graceLeft = Math.max(0, 24 - ageHrs);
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
            paid · {formatTxc(received)}
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
              <div>{formatTxc(received)}</div>
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
              {graceLeft > 0 ? `${graceLeft.toFixed(1)}h` : "0h"}
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