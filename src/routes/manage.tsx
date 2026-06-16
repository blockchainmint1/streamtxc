import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { CheckCircle2, Film, Clock } from "lucide-react";
import { toast } from "sonner";
import { NotificationPrefs } from "@/components/NotificationPrefs";

export const Route = createFileRoute("/manage")({
  head: () => ({
    meta: [{ title: "My videos — stream.texitcoin" }],
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
      className="font-mono h-7 w-7"
      title="Finalize HLS"
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
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
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

function ManagePageInner() {
  const { address } = useWallet();
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

  const { data: videos, isLoading } = useQuery({
    queryKey: ["my-videos", address],
    queryFn: () => (address ? fetchMine({ data: { wallet: address } }) : []),
    enabled: !!address,
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
          <div className="border border-border rounded-sm overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead className="bg-card font-mono text-xs text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3">Title</th>
                  <th className="text-left px-4 py-3">Size</th>
                  <th className="text-left px-4 py-3">Views</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Expires</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {[...videos]
                  .sort(
                    (a, b) =>
                      new Date(a.expires_at).getTime() -
                      new Date(b.expires_at).getTime(),
                  )
                  .map((v) => {
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
        )}
      </main>
      <Footer />
    </div>
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
  const months = 1;

  async function load() {
    setLoading(true);
    try {
      const res = await buildQuote({ data: { wallet, months } });
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
      // Mempool-OK: don't make the user wait for a block. We trust the txid.
      const res = await verifyTx({ data: { txHash, requireConfirmed: false } });
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
          <CalendarPlus className="mr-2 h-4 w-4" /> extend all +30d
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Bulk extend +30 days</DialogTitle>
          <DialogDescription>
            Paste this <span className="font-mono">sendmany</span> into your TXC
            web wallet, broadcast it, then paste the txid below to verify and
            credit each video by the exact amount paid.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center font-mono text-muted-foreground">
            <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
            building quote…
          </div>
        ) : !quote ? null : quote.items.length === 0 ? (
          <p className="font-mono text-muted-foreground py-6">
            No videos with deposit addresses to extend.
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
                          {verifyResult.unmatched.length} output(s) didn't match any video wallet.
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