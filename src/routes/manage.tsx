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
  editVideoMetadata,
  pinThumbnail,
  getOwnershipChallenge,
  submitOwnershipProof,
  retryOwnStamp,
} from "@/lib/videos.functions";
import { useWallet } from "@/lib/wallet";
import { formatBytes, shortenHash } from "@/lib/fees";
import { ipfsThumbUrl } from "@/lib/ipfs-gateway";
import {
  ArrowUpRight,
  AlertTriangle,
  Pencil,
  Loader2,
  Upload as UploadIcon,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/manage")({
  head: () => ({
    meta: [{ title: "My videos — stream.texitcoin" }],
  }),
  component: ManagePage,
});

function ManagePage() {
  return <ManagePageInner />;
}

function RetryStampButton({ cid, wallet }: { cid: string; wallet: string }) {
  const qc = useQueryClient();
  const retry = useServerFn(retryOwnStamp);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="font-mono"
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
      <span className="ml-1">retry stamp</span>
    </Button>
  );
}

function ManagePageInner() {
  const { address, connect } = useWallet();
  const fetchMine = useServerFn(listMyVideos);

  useEffect(() => {
    if (!address) connect();
  }, [address, connect]);

  const { data: videos, isLoading } = useQuery({
    queryKey: ["my-videos", address],
    queryFn: () => (address ? fetchMine({ data: { wallet: address } }) : []),
    enabled: !!address,
  });

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 py-12 flex-1">
        <div className="font-mono text-xs text-primary mb-3">[ MY VIDEOS ]</div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Manage</h1>
        <p className="text-muted-foreground mb-10">
          Videos uploaded from this browser.
        </p>

        {!address || isLoading ? (
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
                {videos.map((v) => {
                  const exp = new Date(v.expires_at);
                  const daysLeft = Math.ceil(
                    (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
                  );
                  const expiring = daysLeft < 7;
                  return (
                    <tr
                      key={v.cid}
                      className="border-t border-border hover:bg-card/50"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {v.thumbnail_cid ? (
                            <img
                              src={ipfsThumbUrl(v.thumbnail_cid)}
                              alt=""
                              className="h-10 w-16 object-cover rounded-sm border border-border bg-secondary shrink-0"
                            />
                          ) : (
                            <div className="h-10 w-16 rounded-sm border border-dashed border-border bg-secondary shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-bold truncate max-w-xs">
                              {v.title}
                            </div>
                            <div className="font-mono text-[10px] text-muted-foreground truncate max-w-xs">
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
                            v.status === "active"
                              ? "text-primary"
                              : "text-muted-foreground"
                          }
                        >
                          {v.status}
                        </span>
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
                          <EditVideoDialog
                            cid={v.cid}
                            initialTitle={v.title}
                            initialDescription={v.description ?? ""}
                            initialThumbCid={v.thumbnail_cid ?? null}
                            wallet={address!}
                          />
                          <Link to="/v/$cid" params={{ cid: v.cid }}>
                            <Button
                              size="sm"
                              variant="outline"
                              className="font-mono"
                            >
                              view <ArrowUpRight className="ml-1 h-3 w-3" />
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
        <Button size="sm" variant="outline" className="font-mono">
          <Pencil className="mr-1 h-3 w-3" /> edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
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
  const [step, setStep] = useState<"wallet" | "sign">("wallet");
  const [wallet, setWallet] = useState(currentWallet);
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep("wallet");
    setWallet(currentWallet);
    setMessage("");
    setSignature("");
    setBusy(false);
  }

  async function handleStartChallenge() {
    if (!wallet) return;
    setBusy(true);
    try {
      const res = await challenge({ data: { cid, ownerWallet: wallet } });
      setMessage(res.message);
      setStep("sign");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    if (!signature) return;
    setBusy(true);
    try {
      const res = await submit({
        data: { cid, ownerWallet: wallet, signature: signature.trim() },
      });
      if (res.releasedTxc > 0) {
        toast.success(
          `Verified — released ${res.releasedTxc.toFixed(4)} TXC from escrow`,
        );
      } else {
        toast.success("Wallet ownership verified on chain");
      }
      qc.invalidateQueries({ queryKey: ["my-videos"] });
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy(false);
    }
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

        {step === "wallet" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="font-mono text-xs">PAYOUT TXC ADDRESS</Label>
              <Input
                value={wallet}
                onChange={(e) => setWallet(e.target.value)}
                placeholder="txc1q..."
                className="font-mono text-xs"
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
                — you'll need its "Sign message" feature next.
              </p>
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
                onClick={handleStartChallenge}
                disabled={!wallet || busy}
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" /> issuing…
                  </>
                ) : (
                  "next: sign message"
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="font-mono text-xs">1. SIGN THIS MESSAGE</Label>
              <Textarea
                value={message}
                readOnly
                rows={5}
                className="font-mono text-[11px]"
              />
              <p className="font-mono text-[10px] text-muted-foreground">
                Open wallet.texitcoin.org → Sign message → paste this exactly.
              </p>
            </div>
            <div className="space-y-2">
              <Label className="font-mono text-xs">2. PASTE SIGNATURE</Label>
              <Textarea
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                rows={3}
                placeholder="H+...="
                className="font-mono text-[11px]"
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                className="font-mono"
                onClick={() => setStep("wallet")}
                disabled={busy}
              >
                back
              </Button>
              <Button
                className="font-mono"
                onClick={handleSubmit}
                disabled={!signature || busy}
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
        )}
      </DialogContent>
    </Dialog>
  );
}