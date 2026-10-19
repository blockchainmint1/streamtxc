import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useWallet } from "@/lib/wallet";
import { getVideo, reseedVideo } from "@/lib/videos.functions";
import { computeCids } from "@/lib/ipfs-cid";
import { formatBytes, MAX_UPLOAD_BYTES } from "@/lib/fees";
import { shortWalletId } from "@/lib/wallet";
import {
  Upload as UploadIcon,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  FileVideo,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/v/$cid/restore")({
  head: () => ({ meta: pageMeta("Restore video — streamTXC", "Restore your original video file to streamTXC while preserving its content identity and ownership records.") }),
  component: RestorePage,
});

function RestorePage() {
  const { cid } = Route.useParams();
  const navigate = useNavigate();
  const { address, isAuthenticated } = useWallet();
  const fetchVideo = useServerFn(getVideo);
  const reseedFn = useServerFn(reseedVideo);

  const { data: video, isLoading } = useQuery({
    queryKey: ["video", cid],
    queryFn: () => fetchVideo({ data: { cid } }),
  });

  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [computedCid, setComputedCid] = useState<{ v1: string; v0: string } | null>(null);
  const [hashing, setHashing] = useState(false);
  const [stage, setStage] = useState<"idle" | "uploading" | "registering">("idle");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!file) {
      setComputedCid(null);
      return;
    }
    let cancelled = false;
    setHashing(true);
    computeCids(file)
      .then((cids) => {
        if (!cancelled) setComputedCid(cids);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not hash this file.");
      })
      .finally(() => {
        if (!cancelled) setHashing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const cidMatches =
    !!video?.cid &&
    !!computedCid &&
    (computedCid.v1 === video.cid || computedCid.v0 === video.cid);

  const isOwner =
    !!address &&
    !!video?.owner_wallet &&
    address.toLowerCase() === video.owner_wallet.toLowerCase();

  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

  async function uploadAndReseed() {
    if (!file || !cidMatches || !video) return;
    try {
      setStage("uploading");
      setProgress(0);
      const form = new FormData();
      form.append("file", file, file.name.slice(0, 200));
      form.append("filename", file.name.slice(0, 200));
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/public/upload");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress((e.loaded / e.total) * 100);
        };
        xhr.onload = () => {
          try {
            const json = JSON.parse(xhr.responseText) as { cid?: string; error?: string };
            if (xhr.status >= 200 && xhr.status < 300 && json.cid) {
              if (json.cid !== video.cid && json.cid !== computedCid?.v0) {
                reject(new Error(`IPFS returned a different CID (${json.cid}). The file may have been transcoded by your OS.`));
                return;
              }
              resolve();
            } else {
              reject(new Error(json.error || `Upload failed (${xhr.status})`));
            }
          } catch {
            reject(new Error(`Upload failed (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.send(form);
      });

      setStage("registering");
      const res = await reseedFn({ data: { cid: video.cid } });
      if (res.expired) {
        toast.success("Re-seeded — but hosting has expired. Renew to keep it pinned.");
      } else {
        toast.success("Video re-seeded.");
      }
      navigate({ to: "/v/$cid", params: { cid: video.cid } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-seed failed");
      setStage("idle");
    }
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
        <div className="flex-1 flex items-center justify-center font-mono text-muted-foreground">
          Video not found.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl px-6 py-10 flex-1 space-y-6">
        <Link
          to="/v/$cid"
          params={{ cid: video.cid }}
          className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> back to video
        </Link>

        <div>
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            re-seed
          </p>
          <h1 className="text-2xl font-bold tracking-tight mt-1">{video.title}</h1>
          <p className="text-sm text-muted-foreground mt-2">
            Re-upload the <span className="text-foreground">exact original file</span>{" "}
            for this video. We'll verify its CID matches{" "}
            <span className="font-mono text-foreground break-all">{video.cid}</span>,
            re-pin it to our IPFS node, and clear the expired flag. Title,
            payment address, and on-chain history are preserved.
          </p>
        </div>

        {!isAuthenticated || !isOwner ? (
          <div className="border-2 border-amber-500/60 bg-amber-500/5 rounded-sm p-5 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-sm">
              {!isAuthenticated ? (
                <>You must connect and sign in with the original uploader's wallet to re-seed this video.</>
              ) : (
                <>
                  Only the original uploader's wallet can re-seed this video.
                  Connected wallet: <span className="font-mono">{address ? shortWalletId(address) : "—"}</span>.
                  Required: <span className="font-mono">{video.owner_wallet ? shortWalletId(video.owner_wallet) : "—"}</span>.
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <label
              className={`block border-2 border-dashed rounded-sm p-8 cursor-pointer transition-colors bg-card ${
                isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setIsDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
            >
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setFile(f);
                }}
              />
              {file ? (
                <div className="flex items-center gap-4">
                  <FileVideo className="h-8 w-8 text-primary" />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm truncate">{file.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center">
                  <UploadIcon className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <div className="font-mono text-sm">
                    {isDragging ? "drop to upload" : "drag & drop or click to choose the original file"}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground mt-1">
                    max {formatBytes(MAX_UPLOAD_BYTES)}
                  </div>
                </div>
              )}
            </label>

            {file && (
              <div className="border border-border rounded-sm p-4 space-y-2 font-mono text-xs">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">original cid</span>
                  <span className="text-foreground break-all text-right">{video.cid}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">your file's cid</span>
                  <span className="text-foreground break-all text-right">
                    {hashing ? (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> hashing…
                      </span>
                    ) : computedCid ? (
                      computedCid.v1
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
                <div className="flex justify-between gap-4 border-t border-border pt-2">
                  <span className="text-muted-foreground">match</span>
                  {hashing ? (
                    <span className="text-muted-foreground">checking…</span>
                  ) : cidMatches ? (
                    <span className="text-primary inline-flex items-center gap-1.5">
                      <CheckCircle2 className="h-3 w-3" /> matches — ready to re-seed
                    </span>
                  ) : computedCid ? (
                    <span className="text-destructive">
                      no — this isn't the original file
                    </span>
                  ) : null}
                </div>
              </div>
            )}

            {tooBig && (
              <div className="text-sm text-destructive font-mono">
                File over {formatBytes(MAX_UPLOAD_BYTES)} — direct upload not supported.
              </div>
            )}

            {stage === "uploading" && (
              <div className="space-y-2">
                <Progress value={progress} />
                <div className="font-mono text-xs text-muted-foreground text-right">
                  {progress.toFixed(0)}% · re-pinning to IPFS
                </div>
              </div>
            )}

            <Button
              size="lg"
              className="w-full font-mono"
              disabled={!file || !cidMatches || tooBig || stage !== "idle" || hashing}
              onClick={uploadAndReseed}
            >
              {stage === "idle" ? (
                <>
                  <UploadIcon className="mr-2 h-4 w-4" />
                  Re-seed video
                </>
              ) : (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {stage === "uploading" ? "uploading…" : "registering…"}
                </>
              )}
            </Button>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}