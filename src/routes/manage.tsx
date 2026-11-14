import { publicOrigin } from "@/lib/site-origin";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  listMyVideos,
  listVideosByCids,
  editVideoMetadata,
  pinThumbnail,
  getOwnershipChallenge,
  submitOwnershipProof,
  retryOwnStamp,
  retryOwnTranscode,
  finalizeOwnTranscode,
  buildBulkExtendQuote,
  verifyBulkExtensionTx,
  setVideoVisibility,
  mirrorOwnToSelfNode,
  forceBackfillTranscript,
} from "@/lib/videos.functions";
import { useWallet, isSignableOwnershipTxcAddress } from "@/lib/wallet";
import { listAnonUploads, removeAnonUpload, subscribeToAnonUploads } from "@/lib/anon-uploads";
import { formatBytes, shortenHash } from "@/lib/fees";
import { ipfsThumbUrl } from "@/lib/ipfs-gateway";
import { ThumbnailPicker } from "@/components/ThumbnailPicker";
import {
  ArrowUpRight,
  AlertTriangle,
  Pencil,
  Loader2,
  Upload as UploadIcon,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  CalendarPlus,
  Copy,
  Eye,
  EyeOff,
  CloudUpload,
  Video,
} from "lucide-react";
import { CheckCircle2, Film, Clock, ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { Captions } from "lucide-react";
import { toast } from "sonner";
import { NotificationPrefs } from "@/components/NotificationPrefs";
import { MeetingRoomsManager } from "@/components/meet/HostPanel";
import { SignInSecuritySection } from "@/components/SignInSecurity";
import { ADMIN_WALLET } from "@/lib/admin";
import { BranchSharePanel } from "@/components/BranchSharePanel";
import { listBugReports } from "@/lib/bug-reports.functions";
import {
  listLiveEligibleWallets,
  setLiveEligibility,
  getMyLiveEligibility,
} from "@/lib/live-eligibility.functions";
import {
  getMyLiveChannel,
  provisionMyLiveChannel,
  rotateMyStreamKey,
  startMyStream,
  stopMyStream,
  markMyStreamLive,
  describeMyChannelState,
  getMySignalHealth,
  listMyLiveStreams,
} from "@/lib/live-channels.functions";
import {
  getMyLiveBalance,
  getMyLiveDepositInfo,
  listMyLiveLedger,
} from "@/lib/live-credits.functions";
import {
  listRecentLiveStreams,
  createLiveStream,
  startLiveStream,
  warmUpLiveStream,
  stopLiveStream,
  markLiveStreamRunning,
  updateLiveStream,
  describeMediaLiveChannel,
  archiveLiveStream,
  skipLiveArchive,
  getRtmpConfig,
  getLiveSignalHealth,
  rotateAdminStreamKey,
} from "@/lib/livestream.functions";
import { Radio } from "lucide-react";

export const Route = createFileRoute("/manage")({
  head: () => ({
    meta: [
      { title: "My videos — streamTXC" },
      { name: "description", content: "Manage your streamTXC videos, wallet branch, renewals and live broadcasts." },
      { property: "og:title", content: "My videos — streamTXC" },
      { property: "og:description", content: "Manage your streamTXC videos, wallet branch, renewals and live broadcasts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ManagePage,
});

function ManagePage() {
  return <ManagePageInner />;
}

function TranscodeBadge({
  status,
  hlsCid,
  cid,
}: {
  status: string | null;
  hlsCid: string | null;
  cid: string;
}) {
  if (!status && !hlsCid) return null;
  if (status === "complete" || hlsCid) {
    return (
      <Link
        to="/v/$cid"
        params={{ cid }}
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-primary hover:underline"
        title="Open enhanced HLS player"
      >
        <CheckCircle2 className="h-3 w-3" /> hls ready · v2
      </Link>
    );
  }
  if (status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-amber-500">
        <Loader2 className="h-3 w-3 animate-spin" /> transcoding
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <Clock className="h-3 w-3" /> queued
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-destructive">
        <AlertTriangle className="h-3 w-3" /> transcode failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      <Film className="h-3 w-3" /> {status}
    </span>
  );
}

function RetryStampButton({ cid, wallet }: { cid: string; wallet: string }) {
  const qc = useQueryClient();
  const retry = useServerFn(retryOwnStamp);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon"
      variant="outline"
      className="font-mono h-7 w-7"
      title="Retry stamp"
      aria-label="Retry on-chain stamp"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await retry({ data: { wallet, cid } });
          if (res.ok) {
            toast.success("Re-broadcast to TXC");
            qc.invalidateQueries({ queryKey: ["my-videos"] });
          } else {
            const err =
              ("cStamp" in res && res.cStamp?.error) ||
              ("tStamp" in res && res.tStamp?.error) ||
              "Retry failed";
            toast.error(String(err));
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Retry failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
    </Button>
  );
}

function RetryTranscodeButton({ cid, wallet }: { cid: string; wallet: string }) {
  const qc = useQueryClient();
  const retry = useServerFn(retryOwnTranscode);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon"
      variant="outline"
      className="font-mono h-7 w-7 text-[10px]"
      title="Retry transcode"
      aria-label="Retry transcode"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await retry({ data: { wallet, cid } });
          if (res.ok) {
            if ("alreadyTranscoded" in res && res.alreadyTranscoded) {
              toast.success("Already transcoded");
            } else {
              toast.success("Transcoding restarted");
            }
            qc.invalidateQueries({ queryKey: ["my-videos"] });
          } else {
            toast.error("Retry failed");
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Retry failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="font-bold">T</span>}
    </Button>
  );
}

function FinalizeTranscodeButton({ cid, wallet }: { cid: string; wallet: string }) {
  const qc = useQueryClient();
  const finalize = useServerFn(finalizeOwnTranscode);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon"
      variant="outline"
      className="font-mono h-7 w-7 text-[10px]"
      title="Finalize HLS"
      aria-label="Finalize HLS"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await finalize({ data: { wallet, cid } });
          if (res.ok) {
            if ("alreadyFinalized" in res && res.alreadyFinalized) {
              toast.success("Already finalized");
            } else {
              toast.success(`Finalized — pinned ${res.keys} files`);
            }
            qc.invalidateQueries({ queryKey: ["my-videos"] });
          } else {
            toast.error("Finalize failed");
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Finalize failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="font-bold">H</span>}
    </Button>
  );
}

function ToggleVisibilityButton({
  cid,
  wallet,
  hidden,
}: {
  cid: string;
  wallet: string;
  hidden: boolean;
}) {
  const qc = useQueryClient();
  const toggle = useServerFn(setVideoVisibility);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon"
      variant="outline"
      className="font-mono h-7 w-7"
      disabled={busy}
      title={hidden ? "Show this video publicly" : "Hide from public listings"}
      aria-label={hidden ? "Show this video publicly" : "Hide from public listings"}
      onClick={async () => {
        setBusy(true);
        try {
          await toggle({ data: { wallet, cid, hidden: !hidden } });
          toast.success(hidden ? "Video shown" : "Video hidden");
          qc.invalidateQueries({ queryKey: ["my-videos"] });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : hidden ? (
        <EyeOff className="h-3 w-3" />
      ) : (
        <Eye className="h-3 w-3" />
      )}
    </Button>
  );
}

function MirrorToSelfNodeButton({ cid, wallet }: { cid: string; wallet: string }) {
  const mirror = useServerFn(mirrorOwnToSelfNode);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon"
      variant="outline"
      className="font-mono h-7 w-7"
      title="Mirror CIDs to honest.money self-node"
      aria-label="Mirror CIDs to honest.money self-node"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await mirror({ data: { wallet, cid } });
          if (res.ok) {
            toast.success(`Mirrored ${res.pinned} CID${res.pinned === 1 ? "" : "s"}`);
          } else {
            const firstErr = res.results.find((r) => !r.ok)?.error ?? "unknown";
            toast.warning(
              `Mirrored ${res.pinned}, ${res.failed} failed — ${firstErr}`,
            );
          }
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Mirror failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudUpload className="h-3 w-3" />}
    </Button>
  );
}

function ForceCaptionsButton({
  cid,
  wallet,
  hasTranscript,
}: {
  cid: string;
  wallet: string;
  hasTranscript: boolean;
}) {
  const qc = useQueryClient();
  const run = useServerFn(forceBackfillTranscript);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="icon"
      variant="outline"
      className="font-mono h-7 w-7"
      title={hasTranscript ? "Transcript ready" : "Make a transcript"}
      aria-label="Make a transcript"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await run({ data: { wallet, cid } });
          if (res.action === "already_transcribed") {
            toast.success("Transcript already exists");
          } else if (res.action === "transcribed_from_existing_audio") {
            toast.success("Transcript ready — it shows under the video");
          } else if (res.action === "audio_job_queued") {
            toast.success("Working on it — the transcript will appear in a few minutes");
          } else if (res.action === "skipped_no_input") {
            toast.error("Source video unavailable");
          } else if (res.action === "skipped_too_large") {
            toast.error("Source too large for automatic backfill");
          } else {
            toast.error(res.error ?? "Caption backfill failed");
          }
          qc.invalidateQueries({ queryKey: ["my-videos"] });
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Caption backfill failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Captions
          className={`h-3 w-3 ${hasTranscript ? "text-green-500" : ""}`}
        />
      )}
    </Button>
  );
}

function ManagePageInner() {
  const { address, isAuthenticated } = useWallet();
  const fetchMine = useServerFn(listMyVideos);
  const fetchByCids = useServerFn(listVideosByCids);

  // Track CIDs uploaded anonymously from this browser so they can be claimed.
  const [anonCids, setAnonCids] = useState<string[]>(() =>
    listAnonUploads().map((r) => r.cid),
  );
  useEffect(() => {
    return subscribeToAnonUploads(() => {
      setAnonCids(listAnonUploads().map((r) => r.cid));
    });
  }, []);

  // No auto-connect — show a "connect wallet" prompt below if missing.

  // Only call the gated server fn once we hold a *valid signed session*, not
  // merely a remembered address — otherwise it throws "You must connect a
  // wallet to do that." and takes the page down with it.
  const { data: videos, isLoading } = useQuery({
    queryKey: ["my-videos", address],
    queryFn: () =>
      address && isAuthenticated ? fetchMine({ data: { wallet: address } }) : [],
    enabled: !!address && isAuthenticated,
    retry: false,
    throwOnError: false,
  });

  const { data: anonVideos } = useQuery({
    queryKey: ["anon-videos", anonCids],
    queryFn: () =>
      anonCids.length === 0
        ? []
        : fetchByCids({ data: { cids: anonCids } }),
    enabled: anonCids.length > 0,
  });

  // Once an anon video has been claimed (owner_wallet set + verified) AND
 // matches the connected wallet, drop it from the local anon list — it now
  // shows up in the main "my videos" table.
  useEffect(() => {
    if (!anonVideos || !address) return;
    for (const v of anonVideos) {
      if (
        v.owner_wallet &&
        v.owner_wallet.toLowerCase() === address.toLowerCase()
      ) {
        removeAnonUpload(v.cid);
      }
    }
  }, [anonVideos, address]);

  const unclaimedAnon = (anonVideos ?? []).filter(
    (v) => !v.owner_wallet || v.owner_proof_status !== "verified",
  );

  // Sorting + pagination state for the videos table.
  type SortKey = "title" | "size_bytes" | "view_count" | "status" | "expires_at";
  const [sortKey, setSortKey] = useState<SortKey>("expires_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "view_count" || key === "size_bytes" ? "desc" : "asc");
    }
    setPage(1);
  };

  const sortedVideos = useMemo(() => {
    if (!videos) return [] as NonNullable<typeof videos>;
    const arr = [...videos] as NonNullable<typeof videos>;
    const dir = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case "title":
          av = (a.title ?? "").toLowerCase();
          bv = (b.title ?? "").toLowerCase();
          break;
        case "size_bytes":
          av = a.size_bytes ?? 0;
          bv = b.size_bytes ?? 0;
          break;
        case "view_count":
          av = a.view_count ?? 0;
          bv = b.view_count ?? 0;
          break;
        case "status":
          av = a.hidden_at ? "hidden" : (a.status ?? "");
          bv = b.hidden_at ? "hidden" : (b.status ?? "");
          break;
        case "expires_at":
        default:
          av = new Date(a.expires_at).getTime();
          bv = new Date(b.expires_at).getTime();
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [videos, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedVideos.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedVideos = sortedVideos.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function SortHeader({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k;
    const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className="text-left px-4 py-3">
        <button
          type="button"
          onClick={() => toggleSort(k)}
          className={
            "inline-flex items-center gap-1 hover:text-foreground transition-colors " +
            (active ? "text-foreground" : "")
          }
        >
          {label}
          <Icon className="h-3 w-3 opacity-70" />
        </button>
      </th>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 py-12 flex-1">
        <div className="font-mono text-xs text-primary mb-3">[ MY VIDEOS ]</div>
        <div className="flex items-start justify-between gap-4 mb-10">
          <div>
            <h1 className="text-4xl font-bold tracking-tight mb-2">Manage</h1>
            <p className="text-muted-foreground">
              Videos uploaded from this browser.
            </p>
          </div>
          {address && videos && videos.length > 0 && (
            <BulkExtendDialog wallet={address} />
          )}
        </div>

        {address && isAuthenticated && <BranchSharePanel />}

        {address && <NotificationPrefs wallet={address} />}

        {unclaimedAnon.length > 0 && (
          <div className="mb-10 border-2 border-amber-500/40 bg-amber-500/5 rounded-sm p-5">
            <div className="font-mono text-xs text-amber-500 mb-2">
              [ ANONYMOUS UPLOADS · CLAIM TO LINK A WALLET ]
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              You uploaded {unclaimedAnon.length} video
              {unclaimedAnon.length === 1 ? "" : "s"} without a wallet from this
              browser. Sign a one-time message in your TXC wallet to claim
              ownership and unlock payouts.
            </p>
            <div className="space-y-2">
              {unclaimedAnon.map((v) => (
                <div
                  key={v.cid}
                  className="flex items-center gap-3 border border-border rounded-sm p-3 bg-background"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-bold truncate">{v.title}</div>
                    <div className="font-mono text-[10px] text-muted-foreground truncate">
                      {v.cid}
                    </div>
                  </div>
                  <Link to="/v/$cid" params={{ cid: v.cid }}>
                    <Button size="sm" variant="ghost" className="font-mono">
                      view
                    </Button>
                  </Link>
                  <VerifyOwnershipDialog
                    cid={v.cid}
                    verified={false}
                    currentWallet={address ?? ""}
                    escrowed={Number(v.escrowed_creator_txc ?? 0)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="font-mono text-xs text-muted-foreground"
                    onClick={() => removeAnonUpload(v.cid)}
                    title="Stop tracking this upload in this browser"
                  >
                    dismiss
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {!address ? (
          unclaimedAnon.length > 0 ? null : (
            <div className="border border-dashed border-border rounded-sm p-12 text-center">
              <p className="font-mono text-sm text-muted-foreground mb-4">
                Connect your TXC wallet to see videos you've uploaded, or upload a new one.
              </p>
              <Link to="/upload">
                <Button className="font-mono">Upload a video</Button>
              </Link>
            </div>
          )
        ) : !isAuthenticated ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center">
            <p className="font-mono text-sm text-muted-foreground mb-4">
              Your wallet session has expired. Sign in again with{" "}
              {shortenHash(address)} to manage your videos.
            </p>
          </div>
        ) : isLoading ? (
          <div className="font-mono text-muted-foreground">Loading…</div>
        ) : !videos || videos.length === 0 ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center">
            <p className="font-mono text-sm text-muted-foreground mb-4">
              No videos yet for {shortenHash(address)}
            </p>
            <Link to="/upload">
              <Button className="font-mono">Upload your first</Button>
            </Link>
          </div>
        ) : (
          <>
          <div className="border border-border rounded-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead className="bg-card font-mono text-xs text-muted-foreground">
                <tr>
                  <SortHeader label="Title" k="title" />
                  <SortHeader label="Size" k="size_bytes" />
                  <SortHeader label="Views" k="view_count" />
                  <SortHeader label="Status" k="status" />
                  <SortHeader label="Expires" k="expires_at" />
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {pagedVideos.map((v) => {
                  const exp = new Date(v.expires_at);
                  const daysLeft = Math.ceil(
                    (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
                  );
                  const expiring = daysLeft < 7;
                  return (
                    <tr
                      key={v.cid}
                      className={
                        "border-t border-border hover:bg-card/50 " +
                        (v.hidden_at ? "opacity-50 " : "") +
                        (v.flagged_at ? "bg-amber-500/5" : "")
                      }
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {v.thumbnail_cid ? (
                            <Link to="/v/$cid" params={{ cid: v.cid }}>
                              <img
                                src={ipfsThumbUrl(v.thumbnail_cid)}
                                alt=""
                                className="h-10 w-16 object-cover rounded-sm border border-border bg-secondary shrink-0"
                              />
                            </Link>
                          ) : (
                            <div className="h-10 w-16 rounded-sm border border-dashed border-border bg-secondary shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-bold truncate max-w-[14rem] flex items-center gap-2">
                              <Link to="/v/$cid" params={{ cid: v.cid }} className="truncate hover:underline">
                                {v.title}
                              </Link>
                              {v.is_nsfw && (
                                <span className="shrink-0 rounded-sm border border-destructive px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-destructive">
                                  NSFW
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-[10px] text-muted-foreground truncate max-w-[14rem]">
                              {v.cid}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {formatBytes(v.size_bytes)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {v.view_count}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <span
                          className={
                            v.hidden_at
                              ? "text-muted-foreground"
                              : v.status === "active"
                              ? "text-primary"
                              : "text-muted-foreground"
                          }
                        >
                          {v.hidden_at ? "hidden" : v.status}
                        </span>
                        <div className="mt-1">
                          <TranscodeBadge
                            status={v.transcode_status ?? null}
                            hlsCid={v.hls_cid ?? null}
                            cid={v.cid}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <span
                          className={
                            expiring ? "text-destructive flex items-center gap-1" : ""
                          }
                        >
                          {expiring && <AlertTriangle className="h-3 w-3" />}
                          {daysLeft}d
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {v.status === "stamp_failed" && (
                            <RetryStampButton cid={v.cid} wallet={address!} />
                          )}
                          {!v.hls_cid &&
                            (v.transcode_status === "processing" ||
                              v.transcode_status === "failed") && (
                              <>
                                <FinalizeTranscodeButton cid={v.cid} wallet={address!} />
                                <RetryTranscodeButton cid={v.cid} wallet={address!} />
                              </>
                            )}
                          <ToggleVisibilityButton
                            cid={v.cid}
                            wallet={address!}
                            hidden={!!v.hidden_at}
                          />
                          <MirrorToSelfNodeButton cid={v.cid} wallet={address!} />
                          <ForceCaptionsButton
                            cid={v.cid}
                            wallet={address!}
                            hasTranscript={!!(v.transcript_cid || (v as { transcript_text?: string | null }).transcript_text)}
                          />
                          <EditVideoDialog
                            cid={v.cid}
                            initialTitle={v.title}
                            initialDescription={v.description ?? ""}
                            initialThumbCid={v.thumbnail_cid ?? null}
                            wallet={address!}
                          />
                          <Link to="/v/$cid" params={{ cid: v.cid }}>
                            <Button
                              size="icon"
                              variant="outline"
                              className="font-mono h-7 w-7"
                              title="View"
                            >
                              <ArrowUpRight className="h-3 w-3" />
                            </Button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sortedVideos.length > 0 && (
            <div className="mt-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 font-mono text-xs text-muted-foreground">
              <div>
                Showing {(currentPage - 1) * pageSize + 1}–
                {Math.min(currentPage * pageSize, sortedVideos.length)} of{" "}
                {sortedVideos.length}
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2">
                  <span>Per page</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="bg-card border border-border rounded-sm px-2 py-1 text-foreground"
                  >
                    {[10, 25, 50, 100].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-mono h-7"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </Button>
                  <span className="px-2">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="font-mono h-7"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
          </>
        )}
        {address && <BugReportsAdminSection wallet={address} />}
        {address && <LiveEligibilityAdminSection wallet={address} />}
        {address && <GoLiveAdminSection wallet={address} />}
        {address && <MyGoLiveSection wallet={address} />}
        {address && <ConferenceSection />}
        {address && <SignInSecuritySection />}
      </main>
      <Footer />
    </div>
  );
}


// Conference — the same meeting rooms as /meet: make named rooms, edit them,
// copy their team / view-only links and join.
function ConferenceSection() {
  return (
    <section id="conference" className="mt-16 border-t border-border pt-8 scroll-mt-20">
      <div className="font-mono text-xs text-primary mb-3">[ CONFERENCE ]</div>
      <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
        <Video className="h-5 w-5" /> Conference
      </h2>
      <p className="text-sm text-muted-foreground mb-6 max-w-2xl">
        Your video meeting rooms. Each room has its own team link (talk, camera, screen share) and view-only link
        (watch and listen). Create a room for each meeting you run, rename it any time, and hit Start (or Join, once people are in) to open it.
      </p>
      <MeetingRoomsManager />
    </section>
  );
}

function LiveEligibilityAdminSection({ wallet }: { wallet: string }) {
  const listFn = useServerFn(listLiveEligibleWallets);
  const setFn = useServerFn(setLiveEligibility);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["live-eligible-wallets", wallet],
    queryFn: () => listFn(),
    enabled: wallet === ADMIN_WALLET,
  });
  const [target, setTarget] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);

  if (wallet !== ADMIN_WALLET) return null;

  const submit = async (opts: {
    targetWallet: string;
    live_eligible: boolean;
    live_rate_txc_per_minute?: number | null;
  }) => {
    setBusy(true);
    try {
      await setFn({ data: opts });
      toast.success("Updated");
      setTarget("");
      setRate("");
      await qc.invalidateQueries({ queryKey: ["live-eligible-wallets"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-16 border-t border-border pt-8">
      <div className="font-mono text-xs text-primary mb-3">[ LIVE ELIGIBILITY · ADMIN ]</div>
      <h2 className="text-2xl font-bold mb-2">Livestream eligibility</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Flip <code>live_eligible</code> on for a wallet and (optionally) set a
        per-wallet TXC/minute override. Only listed wallets get the Go Live UI
        on their /manage page.
      </p>

      <div className="rounded-sm border border-border bg-card p-4 mb-4 space-y-3">
        <div className="font-mono text-xs text-muted-foreground">Grant / update a wallet</div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[280px]">
            <Label className="text-xs font-mono">Wallet (T…)</Label>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value.trim())}
              placeholder="T…"
              className="font-mono text-xs"
            />
          </div>
          <div className="w-40">
            <Label className="text-xs font-mono">Rate TXC/min (opt)</Label>
            <Input
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="default"
              inputMode="decimal"
              className="font-mono text-xs"
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !target}
            onClick={() => {
              const parsedRate = rate ? Number(rate) : null;
              if (rate && (!Number.isFinite(parsedRate) || (parsedRate ?? 0) <= 0)) {
                toast.error("Rate must be a positive number");
                return;
              }
              submit({
                targetWallet: target,
                live_eligible: true,
                live_rate_txc_per_minute: parsedRate,
              });
            }}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Enable"}
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="font-mono text-xs text-muted-foreground">loading…</div>
      )}
      {error && (
        <div className="font-mono text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load"}
        </div>
      )}
      {data && data.length === 0 && (
        <div className="font-mono text-xs text-muted-foreground">
          No eligible wallets yet.
        </div>
      )}
      {data && data.length > 0 && (
        <div className="border border-border rounded-sm overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-left p-2">Wallet</th>
                <th className="text-left p-2">Enabled</th>
                <th className="text-left p-2">Rate TXC/min</th>
                <th className="text-left p-2">Max min</th>
                <th className="text-right p-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.wallet} className="border-t border-border">
                  <td className="p-2 truncate max-w-[280px]">{r.wallet}</td>
                  <td className="p-2">{r.live_eligible ? "yes" : "no"}</td>
                  <td className="p-2">{r.live_rate_txc_per_minute ?? "—"}</td>
                  <td className="p-2">{r.live_max_concurrent_minutes}</td>
                  <td className="p-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        submit({
                          targetWallet: r.wallet,
                          live_eligible: !r.live_eligible,
                        })
                      }
                    >
                      {r.live_eligible ? "Disable" : "Enable"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PermanentEmbedRow({ wallet }: { wallet: string }) {
  const origin = publicOrigin();
  const link = `${origin}/embed/live/by-wallet/${wallet}?autoplay=1&mute=1`;
  const iframe = `<iframe src="${link}" width="100%" height="480" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen frameborder="0"></iframe>`;
  return (
    <div className="mb-6 p-3 rounded border border-border bg-muted/40 space-y-2">
      <div className="font-mono text-xs text-muted-foreground">
        Permanent embed link (auto-plays your current stream, shows "Offline" otherwise)
      </div>
      <div className="flex items-center gap-2">
        <Input readOnly value={link} className="font-mono text-xs" />
        <Button
          size="sm"
          variant="outline"
          className="font-mono"
          onClick={() => {
            navigator.clipboard.writeText(link);
            toast.success("Link copied");
          }}
        >
          Copy link
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="font-mono"
          onClick={() => {
            navigator.clipboard.writeText(iframe);
            toast.success("Embed code copied");
          }}
        >
          Copy embed
        </Button>
      </div>
    </div>
  );
}

function BugReportsAdminSection({ wallet }: { wallet: string }) {
  const fetchReports = useServerFn(listBugReports);
  const { data, isLoading, error } = useQuery({
    queryKey: ["bug-reports", wallet],
    queryFn: () => fetchReports(),
    enabled: wallet === ADMIN_WALLET,
  });
  if (wallet !== ADMIN_WALLET) return null;
  return (
    <section className="mt-16 border-t border-border pt-8">
      <div className="font-mono text-xs text-primary mb-3">[ BUG REPORTS · ADMIN ]</div>
      <h2 className="text-2xl font-bold mb-4">Bug reports</h2>
      {isLoading && (
        <div className="font-mono text-xs text-muted-foreground">loading…</div>
      )}
      {error && (
        <div className="font-mono text-xs text-destructive">
          {error instanceof Error ? error.message : "failed to load"}
        </div>
      )}
      {data && data.length === 0 && (
        <div className="font-mono text-xs text-muted-foreground">No bug reports yet.</div>
      )}
      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((r) => (
            <div key={r.id} className="border border-border rounded-sm p-4 bg-card">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="font-mono text-[10px] text-muted-foreground">
                  {new Date(r.created_at).toLocaleString()}
                </div>
                <div className="font-mono text-[10px] text-muted-foreground truncate max-w-[50%]">
                  {r.page_url ?? "—"}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-2">
                <div><span className="text-muted-foreground">name:</span> {r.name || "—"}</div>
                <div><span className="text-muted-foreground">email:</span> {r.email || "—"}</div>
                <div><span className="text-muted-foreground">tg:</span> {r.telegram || "—"}</div>
              </div>
              <pre className="text-sm whitespace-pre-wrap break-words bg-muted/30 p-3 rounded-sm border border-border">
{r.details}
              </pre>
              {r.attachment_data_url && (
                <div className="mt-2">
                  <a
                    href={r.attachment_data_url}
                    download={r.attachment_name ?? "attachment"}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    📎 {r.attachment_name ?? "attachment"} ({r.attachment_type ?? "file"})
                  </a>
                  {r.attachment_type?.startsWith("image/") && (
                    <img
                      src={r.attachment_data_url}
                      alt={r.attachment_name ?? "attachment"}
                      className="mt-2 max-h-64 rounded-sm border border-border"
                    />
                  )}
                </div>
              )}
              {r.reporter_wallet && (
                <div className="mt-2 font-mono text-[10px] text-muted-foreground truncate">
                  wallet: {r.reporter_wallet}
                </div>
              )}
              {r.user_agent && (
                <div className="font-mono text-[10px] text-muted-foreground truncate">
                  ua: {r.user_agent}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EditVideoDialog({
  cid,
  initialTitle,
  initialDescription,
  initialThumbCid,
  wallet,
}: {
  cid: string;
  initialTitle: string;
  initialDescription: string;
  initialThumbCid: string | null;
  wallet: string;
}) {
  const qc = useQueryClient();
  const edit = useServerFn(editVideoMetadata);
  const pin = useServerFn(pinThumbnail);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [thumbCid, setThumbCid] = useState<string | null>(initialThumbCid);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "uploading" | "saving">("idle");
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle(initialTitle);
    setDescription(initialDescription);
    setThumbCid(initialThumbCid);
    setPreviewUrl(null);
    setStage("idle");
  }

  async function handleThumbFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Pick a JPG, PNG, or WebP image");
      return;
    }
    if (file.size > 1_500_000) {
      toast.error("Image must be under 1.5 MB");
      return;
    }
    setStage("uploading");
    try {
      const url = URL.createObjectURL(file);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(url);
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const b64 = btoa(bin);
      const mime =
        file.type === "image/png" || file.type === "image/webp"
          ? (file.type as "image/png" | "image/webp")
          : "image/jpeg";
      const res = await pin({ data: { imageBase64: b64, mimeType: mime } });
      setThumbCid(res.cid);
      toast.success("Thumbnail pinned to IPFS");
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Pin failed");
    } finally {
      setStage("idle");
    }
  }

  async function handleSave() {
    if (!title) return;
    setStage("saving");
    try {
      const res = await edit({
        data: {
          wallet,
          cid,
          title,
          description,
          thumbnailCid: thumbCid,
        },
      });
      if (res.stamped) {
        toast.success("Saved & stamped on TXC");
      } else {
        toast.warning("Saved (chain stamp pending)");
      }
      qc.invalidateQueries({ queryKey: ["my-videos"] });
      qc.invalidateQueries({ queryKey: ["video", cid] });
      setOpen(false);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setStage("idle");
    }
  }

  const displayThumb = previewUrl ?? ipfsThumbUrl(thumbCid);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon" variant="outline" className="font-mono h-7 w-7" title="Edit">
          <Pencil className="h-3 w-3" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">[ EDIT VIDEO ]</DialogTitle>
          <DialogDescription>
            Updates the title, description, or thumbnail. A new metadata JSON is
            pinned to IPFS and stamped on TXC — every edit is its own confirmed
            on-chain event.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="font-mono text-xs">TITLE</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label className="font-mono text-xs">DESCRIPTION</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <Label className="font-mono text-xs">THUMBNAIL</Label>
            <ThumbnailPicker
              videoSrc={`/api/stream/${cid}`}
              onChange={(c) => {
                if (c) {
                  setThumbCid(c);
                  if (previewUrl) URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                }
              }}
            />
            <div className="pt-2 border-t border-border/50">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                or upload your own
              </p>
            <div className="flex items-center gap-3">
              <div className="h-20 w-32 rounded-sm border border-border bg-secondary overflow-hidden flex items-center justify-center shrink-0">
                {displayThumb ? (
                  <img
                    src={displayThumb}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    none
                  </span>
                )}
              </div>
              <div className="flex-1 space-y-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleThumbFile(f);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="font-mono"
                  disabled={stage !== "idle"}
                  onClick={() => fileRef.current?.click()}
                >
                  {stage === "uploading" ? (
                    <>
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" /> pinning…
                    </>
                  ) : (
                    <>
                      <UploadIcon className="mr-2 h-3 w-3" /> upload image
                    </>
                  )}
                </Button>
                {thumbCid && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="font-mono text-xs text-muted-foreground"
                    onClick={() => {
                      setThumbCid(null);
                      if (previewUrl) URL.revokeObjectURL(previewUrl);
                      setPreviewUrl(null);
                    }}
                  >
                    remove
                  </Button>
                )}
                <p className="font-mono text-[10px] text-muted-foreground">
                  jpg / png / webp · max 1.5 MB
                </p>
              </div>
            </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="font-mono"
            onClick={() => setOpen(false)}
            disabled={stage === "saving"}
          >
            cancel
          </Button>
          <Button
            className="font-mono"
            onClick={handleSave}
            disabled={!title || stage !== "idle"}
          >
            {stage === "saving" ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> saving + stamping…
              </>
            ) : (
              "save & stamp"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GoLiveAdminSection({ wallet }: { wallet: string }) {
  const isAdmin = wallet === ADMIN_WALLET;
  const list = useServerFn(listRecentLiveStreams);
  const create = useServerFn(createLiveStream);
  const start = useServerFn(startLiveStream);
  const warmUp = useServerFn(warmUpLiveStream);
  const stop = useServerFn(stopLiveStream);
  const markRunning = useServerFn(markLiveStreamRunning);
  const update = useServerFn(updateLiveStream);
  const describe = useServerFn(describeMediaLiveChannel);
  const archive = useServerFn(archiveLiveStream);
  const skipArchive = useServerFn(skipLiveArchive);
  const rtmpCfg = useServerFn(getRtmpConfig);
  const rotateKey = useServerFn(rotateAdminStreamKey);
  const [rotating, setRotating] = useState(false);
  const signalHealth = useServerFn(getLiveSignalHealth);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["live-streams-admin"],
    queryFn: () => list(),
    enabled: isAdmin,
    refetchInterval: 10_000,
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ytUrl, setYtUrl] = useState("");
  const [xUrl, setXUrl] = useState("");
  const [fbUrl, setFbUrl] = useState("");
  const [showtime, setShowtime] = useState("");
  const [busy, setBusy] = useState(false);
  const [channelState, setChannelState] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const [signal, setSignal] = useState<{
    receiving: boolean;
    lastSequence: number;
    ageSec: number | null;
    status: number;
  } | null>(null);
  const [rtmpEndpoints, setRtmpEndpoints] = useState<
    { serverUrl: string; streamKey: string; fullUrl: string }[]
  >([]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    rtmpCfg()
      .then((r) => !cancelled && setRtmpEndpoints(r.endpoints ?? []))
      .catch(() => !cancelled && setRtmpEndpoints([]));
    return () => {
      cancelled = true;
    };
  }, [isAdmin, wallet, rtmpCfg]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    describe()
      .then((r) => !cancelled && setChannelState(r.state))
      .catch(() => !cancelled && setChannelState("unknown"));
    const iv = setInterval(async () => {
      try {
        const r = await describe();
        if (!cancelled) setChannelState(r.state);
      } catch {}
    }, 5_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [isAdmin, wallet, describe]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    const probe = async () => {
      try {
        const r = await signalHealth();
        if (cancelled) return;
        if ("ok" in r && r.ok) {
          setSignal({
            receiving: r.receiving,
            lastSequence: r.lastSequence,
            ageSec: r.ageSec,
            status: r.status,
          });
        } else {
          setSignal(null);
        }
      } catch {
        if (!cancelled) setSignal(null);
      }
    };
    probe();
    const iv = setInterval(probe, 8_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [isAdmin, wallet, signalHealth]);

  if (!isAdmin) return null;

  async function handleCreate() {
    if (!title.trim()) {
      toast.error("Title required");
      return;
    }
    setBusy(true);
    try {
      await create({
        data: {
          title: title.trim(),
          description: description.trim() || null,
          simulcast_youtube_url: ytUrl.trim() || null,
          simulcast_twitter_url: xUrl.trim() || null,
          simulcast_facebook_url: fbUrl.trim() || null,
          scheduled_for: showtime ? new Date(showtime).toISOString() : null,
        },
      });
      setTitle("");
      setDescription("");
      setYtUrl("");
      setXUrl("");
      setFbUrl("");
      setShowtime("");
      toast.success(
        showtime
          ? "Stream created — AWS will warm up automatically 15 minutes before showtime"
          : "Stream created — click Warm up at least 5 minutes before the show",
      );
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  async function handleStart(id: string) {
    setBusy(true);
    try {
      await start({ data: { id } });
      toast.success(
        channelState === "RUNNING"
          ? "Live! AWS is ready — start StreamYard now"
          : "AWS is warming up — wait for the green READY light before starting StreamYard",
      );
      setChannelState((s) => (s === "RUNNING" ? s : "STARTING"));
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Start failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleWarm(id: string) {
    setBusy(true);
    try {
      await warmUp({ data: { id } });
      toast.success("Warming up AWS — nothing is announced yet. Click Go Live once it's READY.");
      setChannelState((s) => (s === "RUNNING" ? s : "STARTING"));
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Warm-up failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkLive(id: string) {
    setBusy(true);
    try {
      await markRunning({ data: { id } });
      toast.success("Marked LIVE — banner & badge now visible to viewers");
      refetch();
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(id: string) {
    if (!confirm("Stop this stream? MediaLive will shut down.")) return;
    setBusy(true);
    try {
      await stop({ data: { id } });
      toast.success("Stream stopped");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive(id: string) {
    if (!confirm(
      "Archive this stream to your library?\n\n" +
        "We'll stitch the recording into a normal HLS video and pin it to " +
        "IPFS. This takes a few minutes; the video will appear in your " +
        "list when it's ready.",
    )) return;
    setBusy(true);
    try {
      const r = await archive({ data: { id } });
      toast.success(
        r.alreadyStarted
          ? `Archive already ${r.status}`
          : `Archiving ${r.segments ?? "?"} segments — check back in a few minutes`,
      );
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleSkipArchive(id: string) {
    setBusy(true);
    try {
      await skipArchive({ data: { id } });
      refetch();
    } finally {
      setBusy(false);
    }
  }

  const primary = rtmpEndpoints[0];
  const backup = rtmpEndpoints[1];

  return (
    <section className="mt-16 border-t border-border pt-8">
      <div className="font-mono text-xs text-primary mb-3">[ GO LIVE · ADMIN ]</div>
      <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
        <Radio className="h-5 w-5" /> Livestream
      </h2>

      {(() => {
        // Big traffic light: tells the operator exactly when StreamYard may start.
        const warmTimes = (data ?? [])
          .flatMap((s: any) => [
            s.status === "starting" ? s.started_at : null,
            s.status === "scheduled" ? s.warmup_started_at : null,
          ])
          .filter(Boolean)
          .map((t: string) => new Date(t).getTime());
        const since = warmTimes.length ? Math.max(...warmTimes) : null;
        const elapsed = since ? Math.max(0, Math.floor((nowMs - since) / 1000)) : null;
        const mmss =
          elapsed !== null
            ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`
            : null;
        let tone = "border-border bg-card text-muted-foreground";
        let headline = "AWS IS OFF";
        let detail =
          "Click Warm up AWS (or set a showtime) at least 5 minutes before the show. Nothing is announced until you click Go Live.";
        if (channelState === "STARTING") {
          tone = "border-yellow-500 bg-yellow-500/10 text-yellow-500";
          headline = `WARMING UP — DON'T START STREAMYARD YET${mmss ? ` · ${mmss}` : ""}`;
          detail = "AWS usually takes 2–5 minutes. This light turns green the moment it's ready.";
        } else if (channelState === "RUNNING" && signal?.receiving) {
          tone = "border-red-500 bg-red-500/10 text-red-500";
          headline = "ON AIR — RECEIVING VIDEO";
          detail = "AWS is getting your StreamYard feed and recording it.";
        } else if (channelState === "RUNNING") {
          tone = "border-green-500 bg-green-500/10 text-green-500";
          headline = "READY — START STREAMYARD NOW";
          detail = "AWS is accepting video. Everything from here on is broadcast and recorded.";
        } else if (channelState === "STOPPING") {
          headline = "SHUTTING DOWN";
          detail = "AWS is stopping the channel. Wait for it to turn off before warming up again.";
        }
        return (
          <div className={`border-2 rounded-sm p-4 mb-6 font-mono ${tone}`}>
            <div className="text-lg font-bold">{headline}</div>
            <div className="text-xs mt-1 opacity-90">{detail}</div>
          </div>
        );
      })()}


      <div className="border border-border rounded-sm p-4 bg-card mb-6 font-mono text-xs space-y-2">
        <div>
          <span className="text-muted-foreground">MediaLive channel: </span>
          <span className={channelState === "RUNNING" ? "text-red-500" : "text-primary"}>
            {channelState ?? "…"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">MediaPackage signal: </span>
          {signal === null ? (
            <span className="text-muted-foreground">…</span>
          ) : signal.receiving ? (
            <span className="text-red-500">
              RECEIVING · seg #{signal.lastSequence} · {signal.ageSec}s ago
            </span>
          ) : signal.lastSequence > 0 ? (
            <span className="text-yellow-500">
              STALE · last seg #{signal.lastSequence}
              {signal.ageSec !== null ? ` · ${signal.ageSec}s ago` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">
              NO SEGMENTS YET — StreamYard is not delivering to MediaLive
            </span>
          )}
        </div>
        {signal && !signal.receiving && signal.lastSequence === 0 && channelState === "RUNNING" && (
          <div className="text-muted-foreground pt-1 leading-relaxed">
            The channel is up but nothing is flowing. In StreamYard, make sure
            you clicked the big <b>Go live</b> button (not just added the
            destination), and that the Custom RTMP tile shows a green "live"
            indicator. If it says "connecting" for more than ~30s, re-check
            Server URL / Stream key above.
          </div>
        )}
        {!primary && (
          <div className="text-muted-foreground">
            Fetching RTMP endpoint from MediaLive…
          </div>
        )}
        {primary && (
          <div className="grid gap-1">
            <div>
              <span className="text-muted-foreground">StreamYard Server URL: </span>
              <code className="text-primary select-all">{primary.serverUrl}</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(primary.serverUrl);
                  toast.success("Copied");
                }}
                className="ml-2 text-primary hover:underline"
              >
                copy
              </button>
            </div>
            <div>
              <span className="text-muted-foreground">Stream key: </span>
              <code className="text-primary select-all">{primary.streamKey}</code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(primary.streamKey);
                  toast.success("Copied");
                }}
                className="ml-2 text-primary hover:underline"
              >
                copy
              </button>
            </div>
            {backup && (
              <div className="text-muted-foreground pt-1">
                Backup: <code className="text-primary/70 select-all">{backup.serverUrl}</code> · key <code className="text-primary/70 select-all">{backup.streamKey}</code>
              </div>
            )}
            {primary.streamKey.length < 32 && (
              <div className="text-destructive pt-1">
                This stream key is the old, easy-to-guess kind. Make a new one while you're not live, then paste it into StreamYard.
              </div>
            )}
            <div className="pt-1">
              <Button
                size="sm"
                variant="outline"
                className="font-mono h-7"
                disabled={rotating || channelState !== "IDLE"}
                title={channelState !== "IDLE" ? "Stop the channel first" : undefined}
                onClick={async () => {
                  if (!window.confirm("Make a new stream key? The old one stops working right away, so you'll need to paste the new key into StreamYard before your next stream.")) return;
                  setRotating(true);
                  try {
                    const r = await rotateKey();
                    const full = `${r.serverUrl}/${r.streamKey}`;
                    setRtmpEndpoints([{ serverUrl: r.serverUrl, streamKey: r.streamKey, fullUrl: full }]);
                    toast.success("New stream key ready — paste it into StreamYard.");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Couldn't make a new key");
                  } finally {
                    setRotating(false);
                  }
                }}
              >
                {rotating ? "Making new key…" : "Make a new stream key"}
              </Button>
            </div>
            <div className="text-muted-foreground pt-1">
              In StreamYard: Destinations → Custom RTMP → Server URL + Stream key
              go into their two separate fields. Channel must be <b>RUNNING</b>{" "}
              before StreamYard can connect — warm up ahead of time and wait for the green READY light (usually 2–5 min).
            </div>
          </div>
        )}
      </div>

      <div className="border border-border rounded-sm p-4 bg-card mb-6 space-y-3">
        <div className="font-mono text-xs text-primary">Create new stream</div>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Stream title"
          className="font-mono"
        />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What's this stream about? (optional)"
          className="font-mono min-h-20"
        />
        <div className="grid md:grid-cols-3 gap-2">
          <Input
            value={ytUrl}
            onChange={(e) => setYtUrl(e.target.value)}
            placeholder="YouTube live URL (optional)"
            className="font-mono text-xs"
          />
          <Input
            value={xUrl}
            onChange={(e) => setXUrl(e.target.value)}
            placeholder="X live URL (optional)"
            className="font-mono text-xs"
          />
          <Input
            value={fbUrl}
            onChange={(e) => setFbUrl(e.target.value)}
            placeholder="Facebook live URL (optional)"
            className="font-mono text-xs"
          />
        </div>
        <label className="block font-mono text-xs text-muted-foreground">
          Showtime (optional) — AWS warms up automatically 15 minutes before
          <Input
            type="datetime-local"
            value={showtime}
            onChange={(e) => setShowtime(e.target.value)}
            className="font-mono text-xs mt-1"
          />
        </label>
        <Button onClick={handleCreate} disabled={busy} className="font-mono">
          Create stream
        </Button>
      </div>

      {isLoading && (
        <div className="font-mono text-xs text-muted-foreground">loading…</div>
      )}

      {data && data.length === 0 && (
        <div className="font-mono text-xs text-muted-foreground">No streams yet.</div>
      )}

      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((s: any) => {
            const isActive = s.status === "starting" || s.status === "live";
            return (
              <div
                key={s.id}
                className="border border-border rounded-sm p-4 bg-card flex flex-col md:flex-row md:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{s.title}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    id: {s.id.slice(0, 8)}… · status:{" "}
                    <span
                      className={
                        s.status === "live"
                          ? "text-red-500"
                          : s.status === "starting"
                            ? "text-yellow-500"
                            : "text-muted-foreground"
                      }
                    >
                      {s.status}
                    </span>
                    {s.started_at && (
                      <> · started {new Date(s.started_at).toLocaleString()}</>
                    )}
                    {s.status === "scheduled" && s.scheduled_for && (
                      <> · showtime {new Date(s.scheduled_for).toLocaleString()} (auto warm-up 15 min before)</>
                    )}
                    {s.status === "scheduled" && s.warmup_started_at && (
                      <> · warmed {new Date(s.warmup_started_at).toLocaleTimeString()}</>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {s.status === "scheduled" &&
                    channelState !== "RUNNING" &&
                    channelState !== "STARTING" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleWarm(s.id)}
                        disabled={busy}
                        className="font-mono"
                      >
                        Warm up AWS
                      </Button>
                    )}
                  {s.status === "scheduled" && (
                    <Button
                      size="sm"
                      onClick={() => handleStart(s.id)}
                      disabled={busy}
                      className="font-mono bg-red-500 hover:bg-red-600"
                    >
                      Go Live
                    </Button>
                  )}
                  {s.status === "starting" && (
                    <Button
                      size="sm"
                      onClick={() => handleMarkLive(s.id)}
                      disabled={busy}
                      className="font-mono"
                    >
                      Mark LIVE
                    </Button>
                  )}
                  {isActive && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleStop(s.id)}
                      disabled={busy}
                      className="font-mono"
                    >
                      Stop
                    </Button>
                  )}
                  {s.status === "ended" && !s.archive_status && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => handleArchive(s.id)}
                        disabled={busy}
                        className="font-mono"
                      >
                        Archive to library
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSkipArchive(s.id)}
                        disabled={busy}
                        className="font-mono"
                      >
                        Skip
                      </Button>
                    </>
                  )}
                  {s.archive_status === "transcoding" && (
                    <span className="font-mono text-[11px] text-yellow-500">
                      archiving: transcoding…
                    </span>
                  )}
                  {s.archive_status === "pinning" && (
                    <span className="font-mono text-[11px] text-yellow-500">
                      archiving: pinning to IPFS…
                    </span>
                  )}
                  {s.archive_status === "ready" && s.archive_video_cid && (
                    <Link
                      to="/v/$cid"
                      params={{ cid: s.archive_video_cid }}
                      className="inline-flex items-center rounded-sm border border-primary bg-background px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
                    >
                      archived →
                    </Link>
                  )}
                  {s.archive_status === "skipped" && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      archive skipped
                    </span>
                  )}
                  {s.archive_status === "failed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleArchive(s.id)}
                      disabled={busy}
                      className="font-mono text-red-500"
                      title={s.archive_error ?? "archive failed"}
                    >
                      retry archive
                    </Button>
                  )}
                  <Link
                    to="/live"
                    className="inline-flex items-center rounded-sm border border-border bg-background px-3 py-1.5 font-mono text-xs hover:border-primary hover:text-primary transition-colors"
                  >
                    view
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 font-mono text-[11px] text-muted-foreground">
        Flow: Create → Go Live (starts MediaLive channel) → wait ~1 min for
        channel RUNNING → start StreamYard broadcast → click "Mark LIVE" once
        video plays on /live → Stop when done. After stop, choose
        "Archive to library" to save the recording as a normal HLS video, or
        "Skip" to let it expire from S3.
      </p>
    </section>
  );
}

function VerifyOwnershipDialog({
  cid,
  verified,
  currentWallet,
  escrowed,
}: {
  cid: string;
  verified: boolean;
  currentWallet: string;
  escrowed: number;
}) {
  const qc = useQueryClient();
  const challenge = useServerFn(getOwnershipChallenge);
  const submit = useServerFn(submitOwnershipProof);
  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState(currentWallet);
  const [message, setMessage] = useState("");
  const [messageWallet, setMessageWallet] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setWallet(currentWallet);
    setMessage("");
    setMessageWallet("");
    setSignature("");
    setBusy(false);
    setIssuing(false);
  }

  // Auto-issue the challenge as soon as the address looks valid. Debounced
  // so we don't spam the server while the user is still typing/pasting, and
  // re-runs whenever the wallet changes so the message always matches.
  useEffect(() => {
    if (!open) return;
    const trimmed = wallet.trim();
    if (!isSignableOwnershipTxcAddress(trimmed)) {
      setMessage("");
      setMessageWallet("");
      return;
    }
    if (trimmed === messageWallet) return;
    const id = setTimeout(async () => {
      setIssuing(true);
      try {
        const res = await challenge({ data: { cid, ownerWallet: trimmed } });
        setMessage(res.message);
        setMessageWallet(trimmed);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to issue challenge");
      } finally {
        setIssuing(false);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [wallet, open, cid, challenge, messageWallet]);

  async function handleSubmit() {
    console.log("[verify] click", {
      hasSig: !!signature,
      hasMessage: !!message,
      messageWallet,
      cid,
    });
    if (!signature || !message) {
      toast.error("Missing signature or challenge message");
      return;
    }
    if (!messageWallet) {
      toast.error("Challenge wallet missing — re-open the dialog");
      return;
    }
    setBusy(true);
    try {
      const res = await submit({
        data: { cid, ownerWallet: messageWallet, signature: signature.trim() },
      });
      console.log("[verify] success", res);
      if (res.releasedTxc > 0) {
        toast.success(
          `Verified — released ${res.releasedTxc.toFixed(4)} TXC from escrow`,
        );
      } else {
        toast.success("Wallet ownership verified on chain");
      }
      qc.invalidateQueries({ queryKey: ["my-videos"] });
      qc.invalidateQueries({ queryKey: ["anon-videos"] });
      setOpen(false);
    } catch (err) {
      console.error("[verify] failed", err);
      toast.error(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  function copyMessage() {
    if (!message) return;
    navigator.clipboard.writeText(message).then(
      () => toast.success("Message copied"),
      () => toast.error("Copy failed"),
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant={verified ? "ghost" : "outline"}
          className="font-mono"
          title={
            verified
              ? "Ownership verified on chain"
              : "Prove you control the payout wallet"
          }
        >
          {verified ? (
            <ShieldCheck className="h-3 w-3" />
          ) : (
            <>
              <ShieldAlert className="mr-1 h-3 w-3" /> verify
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            [ {verified ? "OWNERSHIP — VERIFIED" : "PROVE OWNERSHIP"} ]
          </DialogTitle>
          <DialogDescription>
            Sign a one-time challenge in your TXC web wallet to prove you
            control the payout address. Until verified, the 90% creator share
            of every paid comment is held in escrow on this video and released
            the moment you verify.
            {escrowed > 0 && (
              <span className="block mt-2 text-amber-500 font-mono text-xs">
                {escrowed.toFixed(4)} TXC currently held in escrow.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="font-mono text-xs">1. PAYOUT TXC ADDRESS</Label>
            <Input
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="T..."
              className="font-mono text-xs"
              autoFocus
            />
            <p className="font-mono text-[10px] text-muted-foreground">
              Comment revenue (90%) will be sent to this address. Open it in{" "}
              <a
                href="https://wallet.texitcoin.org"
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                wallet.texitcoin.org
              </a>{" "}
              and use its "Sign message" feature with the same legacy <span className="text-foreground">T…</span> address. <span className="text-foreground">txc1…</span> addresses are not supported by this verification flow yet.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="font-mono text-xs">2. SIGN THIS MESSAGE</Label>
              {message && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 font-mono text-[10px]"
                  onClick={copyMessage}
                >
                  <Copy className="h-3 w-3 mr-1" /> copy
                </Button>
              )}
            </div>
            <Textarea
              value={
                message
                  ? message
                  : issuing
                    ? "issuing challenge…"
                    : "Enter a legacy T… address above to generate a message."
              }
              readOnly
              rows={5}
              className="font-mono text-[11px]"
            />
          </div>

          <div className="space-y-2">
            <Label className="font-mono text-xs">3. PASTE SIGNATURE</Label>
            <Textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={3}
              placeholder="H+...="
              className="font-mono text-[11px]"
              disabled={!message}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="font-mono"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              cancel
            </Button>
            <Button
              className="font-mono"
              onClick={handleSubmit}
              disabled={!signature || !message || busy || issuing}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" /> verifying…
                </>
              ) : (
                "verify & stamp"
              )}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BulkExtendDialog({ wallet }: { wallet: string }) {
  const qc = useQueryClient();
  const buildQuote = useServerFn(buildBulkExtendQuote);
  const verifyTx = useServerFn(verifyBulkExtensionTx);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [txInput, setTxInput] = useState("");
  const [verifyResult, setVerifyResult] = useState<Awaited<
    ReturnType<typeof verifyBulkExtensionTx>
  > | null>(null);
  const [quote, setQuote] = useState<Awaited<
    ReturnType<typeof buildBulkExtendQuote>
  > | null>(null);
  const [months, setMonths] = useState(1);
  const [windowDays, setWindowDays] = useState(30);

  async function load() {
    setLoading(true);
    try {
      const res = await buildQuote({ data: { wallet, months, windowDays } });
      setQuote(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to build quote");
    } finally {
      setLoading(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Copy failed"),
    );
  }

  async function runVerify() {
    const txHash = txInput.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      toast.error("Paste a 64-char hex txid");
      return;
    }
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await verifyTx({ data: { txHash } });
      setVerifyResult(res);
      if (res.pending) {
        toast.message("TX not confirmed yet — try again after the next block.");
      } else if (res.matched.length === 0) {
        toast.message("No matching video deposit addresses found in this tx.");
      } else {
        toast.success(
          `Credited ${res.matched.length} video${res.matched.length === 1 ? "" : "s"}`,
        );
        qc.invalidateQueries({ queryKey: ["my-videos"] });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verify failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) load();
        else {
          setQuote(null);
          setVerifyResult(null);
          setTxInput("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button className="font-mono shrink-0" variant="outline">
          <CalendarPlus className="mr-2 h-4 w-4" /> bulk renew
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Bulk renew expiring videos</DialogTitle>
          <DialogDescription>
            Pick a window and how many months to add. We'll build one
            <span className="font-mono"> sendmany </span> transaction covering
            every expiring video. Broadcast it from your TXC wallet, then paste
            the txid below to credit each video by the exact amount paid.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-4 border border-border rounded-sm p-3 bg-card/50">
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-window" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              expiring within (days)
            </Label>
            <Input
              id="bulk-window"
              type="number"
              min={1}
              max={3650}
              value={windowDays}
              onChange={(e) => setWindowDays(Math.max(1, Number(e.target.value) || 1))}
              className="font-mono w-28"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bulk-months" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              renew for (months)
            </Label>
            <Input
              id="bulk-months"
              type="number"
              min={1}
              max={24}
              value={months}
              onChange={(e) => setMonths(Math.min(24, Math.max(1, Number(e.target.value) || 1)))}
              className="font-mono w-28"
            />
          </div>
          <Button
            variant="outline"
            className="font-mono"
            onClick={load}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin mr-2" /> : <RefreshCw className="h-3 w-3 mr-2" />}
            rebuild quote
          </Button>
        </div>

        {loading ? (
          <div className="py-8 text-center font-mono text-muted-foreground">
            <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
            building quote…
          </div>
        ) : !quote ? null : quote.items.length === 0 ? (
          <p className="font-mono text-muted-foreground py-6">
            No videos expiring in the next {windowDays} day{windowDays === 1 ? "" : "s"}.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="border border-border rounded-sm overflow-hidden max-h-64 overflow-y-auto">
              <table className="w-full text-xs font-mono">
                <thead className="bg-card text-muted-foreground sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2">Title</th>
                    <th className="text-left px-3 py-2">Address</th>
                    <th className="text-right px-3 py-2">TXC</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.items.map((it) => (
                    <tr key={it.cid} className="border-t border-border">
                      <td className="px-3 py-2 truncate max-w-[200px]">{it.title}</td>
                      <td className="px-3 py-2 truncate max-w-[220px]">
                        {it.depositAddress}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {it.txcAmount.toFixed(8)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-card">
                    <td className="px-3 py-2 font-bold" colSpan={2}>
                      Total ({quote.items.length} videos)
                    </td>
                    <td className="px-3 py-2 text-right font-bold">
                      {quote.totalTxc.toFixed(8)} TXC
                      <div className="text-[10px] text-muted-foreground font-normal">
                        ≈ ${quote.totalUsd.toFixed(2)} @ ${quote.txcUsd.toFixed(4)}/TXC
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div>
              <Label className="font-mono text-xs text-muted-foreground">
                sendmany command
              </Label>
              <div className="mt-1 relative">
                <Textarea
                  readOnly
                  value={quote.sendmanyCli}
                  className="font-mono text-xs h-32 resize-none pr-10"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="absolute top-2 right-2"
                  onClick={() => copy(quote.sendmanyCli)}
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="font-mono text-xs"
                  onClick={() => copy(quote.sendmanyJson)}
                >
                  <Copy className="h-3 w-3 mr-1" /> copy JSON only
                </Button>
              </div>
            </div>

            <div className="border-t border-border pt-4 space-y-2">
              <Label className="font-mono text-xs text-muted-foreground">
                paste txid to verify (mempool is fine — no need to wait for a block)
              </Label>
              <div className="flex gap-2">
                <Input
                  value={txInput}
                  onChange={(e) => setTxInput(e.target.value)}
                  placeholder="64-char hex txid"
                  className="font-mono text-xs"
                />
                <Button
                  className="font-mono shrink-0"
                  onClick={runVerify}
                  disabled={verifying || !txInput.trim()}
                >
                  {verifying ? (
                    <>
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" /> verifying…
                    </>
                  ) : (
                    "verify & credit"
                  )}
                </Button>
              </div>

              {verifyResult && (
                <div className="text-xs font-mono space-y-1 pt-2">
                  {verifyResult.pending ? (
                    <p className="text-amber-500">
                      TX found but not yet confirmed. Wait for the next block.
                    </p>
                  ) : (
                    <>
                      {verifyResult.matched.length > 0 && (
                        <div>
                          <p className="text-green-500">
                            ✓ Credited {verifyResult.matched.length} video(s):
                          </p>
                          <ul className="ml-4 text-muted-foreground">
                            {verifyResult.matched.map((m) => (
                              <li key={m.cid} className="truncate">
                                {m.title} — +{m.daysAdded}d ({m.paidTxc.toFixed(4)} TXC)
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {verifyResult.alreadyCredited.length > 0 && (
                        <p className="text-muted-foreground">
                          {verifyResult.alreadyCredited.length} already credited from this tx (skipped).
                        </p>
                      )}
                      {verifyResult.skippedDust.length > 0 && (
                        <p className="text-muted-foreground">
                          {verifyResult.skippedDust.length} dust output(s) skipped (under 1 day).
                        </p>
                      )}
                      {verifyResult.unmatched.length > 0 && (
                        <p className="text-muted-foreground">
                          {verifyResult.unmatched.length} output(s) returned to the sender as
                          change — that's normal, nothing went wrong.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                className="font-mono"
                onClick={() => setOpen(false)}
              >
                close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------
// MyGoLiveSection — for wallets flagged live_eligible=true on
// wallet_notification_prefs (see LiveEligibilityAdminSection above). Admin
// gets its own GoLiveAdminSection so we hide this one for the admin wallet
// to avoid two Go Live UIs on the same page.
// -----------------------------------------------------------------------
function MyGoLiveSection({ wallet }: { wallet: string }) {
  const eligFn = useServerFn(getMyLiveEligibility);
  const channelFn = useServerFn(getMyLiveChannel);
  const provisionFn = useServerFn(provisionMyLiveChannel);
  const rotateMyKeyFn = useServerFn(rotateMyStreamKey);
  const [rotatingKey, setRotatingKey] = useState(false);
  const startFn = useServerFn(startMyStream);
  const stopFn = useServerFn(stopMyStream);
  const markLiveFn = useServerFn(markMyStreamLive);
  const describeFn = useServerFn(describeMyChannelState);
  const signalFn = useServerFn(getMySignalHealth);
  const listFn = useServerFn(listMyLiveStreams);
  const balanceFn = useServerFn(getMyLiveBalance);
  const depositFn = useServerFn(getMyLiveDepositInfo);
  const ledgerFn = useServerFn(listMyLiveLedger);
  const qc = useQueryClient();

  const elig = useQuery({
    queryKey: ["my-live-eligibility", wallet],
    queryFn: () => eligFn(),
    enabled: !!wallet && wallet !== ADMIN_WALLET,
  });
  const channel = useQuery({
    queryKey: ["my-live-channel", wallet],
    queryFn: () => channelFn(),
    enabled: !!elig.data?.eligible,
  });
  const state = useQuery({
    queryKey: ["my-live-state", wallet],
    queryFn: () => describeFn(),
    enabled: !!channel.data,
    refetchInterval: 5000,
  });
  const signal = useQuery({
    queryKey: ["my-live-signal", wallet],
    queryFn: () => signalFn(),
    enabled: state.data?.state === "RUNNING",
    refetchInterval: 5000,
  });
  const streams = useQuery({
    queryKey: ["my-live-streams", wallet],
    queryFn: () => listFn(),
    enabled: !!elig.data?.eligible,
  });
  const balance = useQuery({
    queryKey: ["my-live-balance", wallet],
    queryFn: () => balanceFn(),
    enabled: !!elig.data?.eligible,
    refetchInterval: 15000,
  });
  const [depositOpen, setDepositOpen] = useState(false);
  const deposit = useQuery({
    queryKey: ["my-live-deposit", wallet],
    queryFn: () => depositFn(),
    enabled: !!elig.data?.eligible && depositOpen,
  });
  const ledger = useQuery({
    queryKey: ["my-live-ledger", wallet],
    queryFn: () => ledgerFn(),
    enabled: !!elig.data?.eligible && depositOpen,
  });

  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  if (wallet === ADMIN_WALLET) return null;
  if (!elig.data?.eligible) return null;

  const activeStream = (streams.data ?? []).find(
    (s: any) => s.status === "starting" || s.status === "live",
  );
  const ch = channel.data;
  const bal = balance.data;
  const canStart = bal ? bal.balanceTxc >= bal.ratePerMin * 5 : false;

  async function handleProvision() {
    setBusy(true);
    try {
      await provisionFn();
      toast.success("Channel provisioned. RTMP credentials are ready.");
      qc.invalidateQueries({ queryKey: ["my-live-channel", wallet] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Provision failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    if (!title.trim()) return toast.error("Give it a title");
    setBusy(true);
    try {
      await startFn({ data: { title, description: desc || null } });
      toast.success("Starting channel — AWS usually takes 2–5 minutes. Wait for RUNNING before starting StreamYard.");
      setTitle("");
      setDesc("");
      qc.invalidateQueries({ queryKey: ["my-live-streams", wallet] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Start failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop(streamId: string) {
    setBusy(true);
    try {
      await stopFn({ data: { streamId } });
      toast.success("Stopped");
      qc.invalidateQueries({ queryKey: ["my-live-streams", wallet] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleMarkLive(streamId: string) {
    try {
      await markLiveFn({ data: { streamId } });
      qc.invalidateQueries({ queryKey: ["my-live-streams", wallet] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <section className="mt-12 border border-primary/20 bg-card p-6 rounded">
      <div className="font-mono text-xs text-primary mb-3">[ GO LIVE ]</div>
      <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
        <Radio className="h-6 w-6" /> Livestream
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        Push a live broadcast to streamTXC from OBS, StreamYard, or any RTMP
        source. Streaming is billed by the minute in TXC.
      </p>

      {/* Credit balance + deposit */}
      <div className="flex items-center gap-3 flex-wrap mb-6 p-3 rounded border border-border bg-muted/40">
        <div className="text-sm">
          <span className="font-mono text-xs text-muted-foreground mr-1">balance:</span>
          <span className="font-mono">{bal ? bal.balanceTxc.toFixed(4) : "…"} TXC</span>
          {bal && (
            <span className="text-muted-foreground text-xs ml-2">
              (~{bal.estimatedMinutes} min @ {bal.ratePerMin} TXC/min)
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="font-mono ml-auto"
          onClick={() => setDepositOpen(true)}
        >
          Add credit
        </Button>
      </div>

      {/* Permanent embed link — same URL every stream */}
      <PermanentEmbedRow wallet={wallet} />


      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono">Add live-stream credit</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Send TXC to the address below. It's credited to your live balance
              automatically once the transaction confirms (usually within one
              cron tick). Rate: {deposit.data?.ratePerMin ?? "…"} TXC/minute.
            </p>
            <div>
              <Label className="font-mono text-xs">Deposit address</Label>
              <div className="flex items-center gap-2 mt-1">
                <Input
                  readOnly
                  value={deposit.data?.address ?? ""}
                  className="font-mono text-xs"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    if (!deposit.data?.address) return;
                    navigator.clipboard.writeText(deposit.data.address);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {ledger.data && ledger.data.length > 0 && (
              <div>
                <div className="font-mono text-xs text-muted-foreground mb-1">
                  Recent activity
                </div>
                <ul className="text-xs space-y-1 max-h-48 overflow-auto">
                  {ledger.data.slice(0, 15).map((r: any) => (
                    <li key={r.id} className="flex justify-between gap-2">
                      <span className="truncate">
                        {r.kind} {r.note ? `— ${r.note}` : ""}
                      </span>
                      <span
                        className={
                          "font-mono " +
                          (Number(r.delta_txc) >= 0 ? "text-green-500" : "text-red-500")
                        }
                      >
                        {Number(r.delta_txc) >= 0 ? "+" : ""}
                        {Number(r.delta_txc).toFixed(4)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {!ch ? (
        <Button onClick={handleProvision} disabled={busy} className="font-mono">
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Enable live (provision channel)
        </Button>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-muted-foreground">state:</span>
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-muted">
                {state.data?.state ?? "…"}
              </span>
              {state.data?.state === "RUNNING" && (
                <span
                  className={
                    "font-mono text-xs px-2 py-0.5 rounded " +
                    (signal.data && "receiving" in signal.data && signal.data.receiving
                      ? "bg-green-500/20 text-green-500"
                      : "bg-yellow-500/20 text-yellow-500")
                  }
                >
                  {signal.data && "receiving" in signal.data && signal.data.receiving
                    ? "RECEIVING"
                    : "NO SEGMENTS YET"}
                </span>
              )}
            </div>
            <div>
              <div className="font-mono text-xs text-muted-foreground mb-1">
                Server URL (paste into StreamYard / OBS)
              </div>
              <div className="flex items-center gap-2">
                <Input readOnly value={ch.rtmpUrl} className="font-mono text-xs" />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(ch.rtmpUrl);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div>
              <div className="font-mono text-xs text-muted-foreground mb-1">Stream key</div>
              <div className="flex items-center gap-2">
                <Input readOnly value={ch.streamKey} className="font-mono text-xs" />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(ch.streamKey);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              {ch.weakStreamKey && (
                <div className="text-xs text-destructive mt-1">
                  This stream key is the old, easy-to-guess kind. Make a new one while you're not live.
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                className="font-mono mt-2"
                disabled={rotatingKey || state.data?.state !== "IDLE"}
                title={state.data?.state !== "IDLE" ? "Stop the channel first" : undefined}
                onClick={async () => {
                  if (!window.confirm("Make a new stream key? The old one stops working right away, so paste the new one into StreamYard / OBS before your next stream.")) return;
                  setRotatingKey(true);
                  try {
                    await rotateMyKeyFn();
                    await qc.invalidateQueries({ queryKey: ["my-live-channel", wallet] });
                    toast.success("New stream key ready — paste it into StreamYard / OBS.");
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Couldn't make a new key");
                  } finally {
                    setRotatingKey(false);
                  }
                }}
              >
                {rotatingKey ? "Making new key…" : "Make a new stream key"}
              </Button>
            </div>
          </div>

          {!activeStream ? (
            <div className="space-y-2 border-t border-border pt-4">
              <Label className="font-mono text-xs">New broadcast</Label>
              <Input
                placeholder="Stream title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Textarea
                placeholder="Description (optional)"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={2}
              />
              <Button onClick={handleStart} disabled={busy} className="font-mono">
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Go Live
              </Button>
              {!canStart && bal && (
                <p className="text-xs text-yellow-500 font-mono">
                  Need at least {(bal.ratePerMin * 5).toFixed(4)} TXC to start
                  (5 min buffer). Click "Add credit".
                </p>
              )}
            </div>
          ) : (
            <div className="border-t border-border pt-4 space-y-2">
              <div className="font-mono text-xs text-muted-foreground">
                Active broadcast: {activeStream.title}
              </div>
              <div className="flex gap-2 flex-wrap">
                {activeStream.status === "starting" && (
                  <Button
                    variant="outline"
                    className="font-mono"
                    onClick={() => handleMarkLive(activeStream.id)}
                  >
                    Mark LIVE
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="font-mono"
                  onClick={() => handleStop(activeStream.id)}
                  disabled={busy}
                >
                  Stop
                </Button>
              </div>
            </div>
          )}

          {streams.data && streams.data.length > 0 && (
            <div className="border-t border-border pt-4">
              <div className="font-mono text-xs text-muted-foreground mb-2">Recent</div>
              <ul className="space-y-1 text-sm">
                {streams.data.slice(0, 5).map((s: any) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className="font-mono text-xs w-16">{s.status}</span>
                    <span className="truncate">{s.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}