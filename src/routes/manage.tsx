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
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/manage")({
  head: () => ({
    meta: [{ title: "My videos — stream.texitcoin" }],
  }),
  component: ManagePage,
});

function ManagePage() {
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
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-card font-mono text-xs text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3">Title</th>
                  <th className="text-left px-4 py-3">Size</th>
                  <th className="text-left px-4 py-3">Views</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Owner</th>
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
                        {v.owner_proof_status === "verified" ? (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <ShieldCheck className="h-3 w-3" /> verified
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-500">
                            <ShieldAlert className="h-3 w-3" /> unverified
                          </span>
                        )}
                        {Number(v.escrowed_creator_txc ?? 0) > 0 && (
                          <div className="text-[10px] text-amber-500 mt-0.5">
                            escrow: {Number(v.escrowed_creator_txc).toFixed(4)} TXC
                          </div>
                        )}
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
                          <VerifyOwnershipDialog
                            cid={v.cid}
                            verified={v.owner_proof_status === "verified"}
                            currentWallet={v.owner_wallet}
                            escrowed={Number(v.escrowed_creator_txc ?? 0)}
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