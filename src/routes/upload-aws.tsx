import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useWallet } from "@/lib/wallet";
import { formatBytes, formatDate, formatTxc, MAX_UPLOAD_BYTES } from "@/lib/fees";
import {
  getUploadUrl,
  registerUpload,
  addByCid,
  getQuote,
  lookupPinnedCid,
} from "@/lib/videos.functions";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import {
  Upload,
  Loader2,
  FileVideo,
  Link2,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Cloud,
} from "lucide-react";
import { parseDuplicateCidError, shortWallet, type DuplicateCidInfo } from "@/lib/duplicate-cid";
import { computeCids } from "@/lib/ipfs-cid";
import { ThumbnailPicker } from "@/components/ThumbnailPicker";
import { recordAnonUpload } from "@/lib/anon-uploads";
import { UrlImportTab } from "@/components/UrlImportTab";
import {
  getTranscodeUploadUrl,
  startTranscode,
  isTranscodeConfigured,
} from "@/lib/transcode.functions";

export const Route = createFileRoute("/upload-aws")({
  head: () => ({
    meta: [
      { title: "Upload (AWS HLS) — stream.texitcoin" },
      {
        name: "description",
        content:
          "Upload a video to IPFS, pay TXC for hosting, get an embeddable player.",
      },
    ],
  }),
  component: UploadPage,
});

/**
 * Pinata's TUS upload encodes the filename into a base64 metadata header
 * via `btoa`, which throws on any character outside Latin1 (emoji, smart
 * quotes, accented chars in some encodings, etc.). Strip the file name
 * down to ASCII before handing it to the SDK.
 */
function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const cleanBase =
    base
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // strip diacritics
      .replace(/[^\x20-\x7E]/g, "") // drop anything non-ASCII (emoji etc.)
      .replace(/[^A-Za-z0-9._\-]+/g, "_") // safe chars only
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "video";
  const cleanExt = ext.replace(/[^A-Za-z0-9.]/g, "").slice(0, 10);
  return cleanBase + cleanExt;
}

/**
 * POST the file to our own Worker, which streams it to Pinata server-side.
 * Same-origin → no Pinata CORS allowlist to maintain. Capped at
 * MAX_UPLOAD_BYTES (~100 MB) by Cloudflare's request-body limit.
 * Uses XHR so we get real upload progress events (fetch can't stream
 * upload progress in any current browser).
 */
async function uploadViaWorker(
  file: File,
  filename: string,
  onProgress: (pct: number) => void,
): Promise<{ cid: string; size: number }> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("filename", filename);

  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/public/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText) as {
          cid?: string;
          size?: number;
          error?: string;
        };
        if (xhr.status >= 200 && xhr.status < 300 && json.cid) {
          resolve({ cid: json.cid, size: json.size ?? file.size });
        } else {
          reject(new Error(json.error || `Upload failed (${xhr.status})`));
        }
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    xhr.send(form);
  });
}

function UploadPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { address } = useWallet();
  const register = useServerFn(registerUpload);
  const addCid = useServerFn(addByCid);
  const quoteFn = useServerFn(getQuote);
  const lookupCid = useServerFn(lookupPinnedCid);
  const getS3Url = useServerFn(getTranscodeUploadUrl);
  const startTx = useServerFn(startTranscode);
  const checkTxConfig = useServerFn(isTranscodeConfigured);

  // No auto-connect: anonymous uploads are allowed. Users can paste a TXC
  // address (and optionally a signature) to claim ownership.

  const [file, setFile] = useState<File | null>(null);
  const [codecWarning, setCodecWarning] = useState<string | null>(null);
  const [localCids, setLocalCids] = useState<{ v1: string; v0: string } | null>(null);
  const [matchedCid, setMatchedCid] = useState<string | null>(null);
  const [cidProbe, setCidProbe] = useState<"idle" | "checking" | "on-ipfs" | "off-ipfs">("idle");
  const [quote, setQuote] = useState<{
    txcAmount: number;
    usdAmount: number;
    txcUsd: number;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [thumbnailCid, setThumbnailCid] = useState<string | null>(null);
  const [cidInput, setCidInput] = useState("");
  const [cidTitle, setCidTitle] = useState("");
  const [cidDescription, setCidDescription] = useState("");
  const [cidThumbnailCid, setCidThumbnailCid] = useState<string | null>(null);
  // Track whether either thumbnail picker is mid-flight so we can both
  // disable Submit AND wait for it before calling register(). Without
  // this, clicking Upload before the picker finishes pins the thumbnail
  // to IPFS but never attaches the CID to the videos row.
  const [thumbPinning, setThumbPinning] = useState(false);
  const [cidThumbPinning, setCidThumbPinning] = useState(false);
  // Mirror state into a ref so handleSubmit always reads the latest CID
  // even if the user picked a frame between clicking Upload and the
  // register() call (the closure would otherwise hold the click-time value).
  const thumbnailCidRef = useRef<string | null>(null);
  useEffect(() => { thumbnailCidRef.current = thumbnailCid; }, [thumbnailCid]);
  const cidThumbnailCidRef = useRef<string | null>(null);
  useEffect(() => { cidThumbnailCidRef.current = cidThumbnailCid; }, [cidThumbnailCid]);
  const [nsfw, setNsfw] = useState(false);
  const [cidNsfw, setCidNsfw] = useState(false);
  const [cidStage, setCidStage] = useState<
    "idle" | "fetching" | "registering"
  >("idle");
  const [cidNotFound, setCidNotFound] = useState<string | null>(null);
  type TabKey = "file" | "cid" | "dropbox" | "import";
  const [activeTab, setActiveTab] = useState<TabKey>("file");
  const tab = activeTab;
  const months = 1;
  const [stage, setStage] = useState<
    "idle" | "hashing" | "checking" | "uploading" | "registering"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [duplicate, setDuplicate] = useState<DuplicateCidInfo | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

  function acceptFile(f: File) {
    setFile(f);
    setCodecWarning(checkCodec(f));
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    setThumbnailCid(null);
  }

  /**
   * When a file is selected, kick off (in parallel) the local CIDv1 hash,
   * the IPFS gateway probe, and the live TXC quote so the user sees the
   * real cost + a "Publish your video" affordance before clicking submit.
   */
  useEffect(() => {
    if (!file || tooBig) {
      setLocalCids(null);
      setMatchedCid(null);
      setCidProbe("idle");
      setQuote(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setCidProbe("checking");
        const [cids, q] = await Promise.all([
          computeCids(file),
          quoteFn({ data: { sizeBytes: file.size, months: 1 } }),
        ]);
        if (cancelled) return;
        setLocalCids(cids);
        setQuote({ txcAmount: q.txcAmount, usdAmount: q.usdAmount, txcUsd: q.txcUsd });
        const hit = await lookupCid({
          data: { cidV1: cids.v1, cidV0: cids.v0 },
        });
        if (cancelled) return;
        setMatchedCid(hit?.cid ?? null);
        setCidProbe(hit ? "on-ipfs" : "off-ipfs");
      } catch (err) {
        if (!cancelled) setCidProbe("off-ipfs");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, tooBig, quoteFn, lookupCid]);

  /**
   * Best-effort browser playability probe. Most browsers don't play
   * .mov containers (ProRes/HEVC), and even some .mp4 files use codecs
   * (HEVC, AV1 in older browsers) that won't decode. We can't peek inside
   * the file from JS without parsing it, so we use the loose extension +
   * MIME signal plus `canPlayType` as a heuristic and recommend H.264 MP4.
   */
  function checkCodec(f: File): string | null {
    const name = f.name.toLowerCase();
    const type = (f.type || "").toLowerCase();
    const v = document.createElement("video");
    // .mov is the most common offender — almost always ProRes or HEVC from
    // a phone/camera, neither plays in Chrome/Firefox.
    if (name.endsWith(".mov") || type === "video/quicktime") {
      return ".mov files often use ProRes or HEVC — most browsers can't play them. Convert to MP4 (H.264 + AAC) before uploading for the best playback experience.";
    }
    // HEVC / H.265 in an mp4 container — Safari plays it, Chrome/Firefox don't.
    if (
      type === "video/mp4" &&
      v.canPlayType('video/mp4; codecs="hvc1"') === "" &&
      v.canPlayType('video/mp4; codecs="hev1"') === ""
    ) {
      // We can't tell from MIME alone whether the file is H.264 or HEVC,
      // so we don't warn here — just trust the container.
    }
    if (!type.startsWith("video/")) {
      return "This doesn't look like a video file. Pick an .mp4 (H.264 + AAC) for the best results.";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !title) return;
    if (tooBig) {
      toast.error(`File too large. Max ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    setDuplicate(null);

    // If the thumbnail picker is still capturing/pinning, wait briefly
    // so the chosen CID actually gets attached to the videos row.
    // Without this, clicking Upload mid-pin pins the thumbnail to IPFS
    // but register() runs with thumbnailCid=null and the picture is lost.
    if (thumbPinning) {
      toast("Waiting for thumbnail to finish pinning…");
      const start = Date.now();
      while (thumbPinning && Date.now() - start < 30_000) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    try {
      // 1. Reuse the CID + IPFS check computed when the file was selected.
      //    Falls back to recomputing if the user submitted before the
      //    background probe finished.
      setStage("hashing");
      setProgress(0);
      const cids = localCids ?? (await computeCids(file));
      setStage("checking");
      const hit =
        matchedCid
          ? { cid: matchedCid }
          : await lookupCid({ data: { cidV1: cids.v1, cidV0: cids.v0 } });
      if (hit) {
        toast("Found this file on IPFS — skipping upload", {
          description: "Registering existing CID instead.",
        });
        setStage("registering");
        const result = await addCid({
          data: {
            wallet: address ?? undefined,
            cid: hit.cid,
            title,
            description,
            months,
            thumbnailCid: thumbnailCidRef.current ?? thumbnailCid ?? undefined,
            nsfw,
          },
        });
        if (result.chainStatus === "stamp_failed") {
          toast.error("Saved from IPFS, but TXC stamp failed");
        } else {
          toast.success("Registered from IPFS");
        }
        if (!address) recordAnonUpload(result.cid, title);
        qc.invalidateQueries({ queryKey: ["recent-videos"] });
        navigate({ to: "/v/$cid", params: { cid: result.cid } });
        return;
      }

      // 3. Not on IPFS yet — stream the file through our Worker to Pinata.
      setStage("uploading");
      const safeName = sanitizeFilename(file.name);
      const pinResult = await uploadViaWorker(file, safeName, (pct) =>
        setProgress(pct),
      );

      // 5. Register metadata + on-chain stamp.
      setStage("registering");
      const result = await register({
        data: {
          wallet: address ?? undefined,
          cid: pinResult.cid,
          title,
          description,
          sizeBytes: pinResult.size || file.size,
          mimeType: file.type || "video/mp4",
          months,
          thumbnailCid: thumbnailCidRef.current ?? thumbnailCid ?? undefined,
          nsfw,
        },
      });

      if (result.chainStatus === "stamp_failed") {
        toast.error("Pinned to IPFS, but TXC stamp failed");
      } else {
        toast.success("Pinned to IPFS");
      }
      if (!address) recordAnonUpload(result.cid, title);
      qc.invalidateQueries({ queryKey: ["recent-videos"] });

      // Kick off the adaptive HLS transcode if AWS is wired up. Surface any
      // errors so silent S3/MediaConvert failures (CORS, expired keys, bad
      // bucket policy) don't disappear into the console — they're the most
      // common reason the AWS pipeline appears not to run.
      try {
        const { configured } = await checkTxConfig();
        if (!configured) {
          toast("AWS transcode not configured — skipping HLS step.");
        } else {
          const ct = file.type || "video/mp4";
          const { url } = await getS3Url({ data: { cid: pinResult.cid, contentType: ct } });
          const putRes = await fetch(url, {
            method: "PUT",
            headers: { "content-type": ct },
            body: file,
          });
          if (!putRes.ok) {
            const body = await putRes.text().catch(() => "");
            console.error("S3 PUT failed", putRes.status, body);
            toast.error(`S3 upload failed (${putRes.status})`, {
              description: body.slice(0, 200) || "Check bucket CORS / credentials.",
            });
          } else {
            const { jobId } = await startTx({ data: { cid: pinResult.cid } });
            toast.success("HLS transcode started", { description: `Job ${jobId}` });
          }
        }
      } catch (err) {
        console.error("transcode kickoff failed:", err);
        toast.error("Transcode kickoff failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      }

      navigate({ to: "/v/$cid", params: { cid: result.cid } });
    } catch (err) {
      console.error(err);
      const dup = parseDuplicateCidError(err);
      if (dup) {
        setDuplicate(dup);
        toast.error("This video is already on stream.");
      } else {
        toast.error(err instanceof Error ? err.message : "Upload failed");
      }
      setStage("idle");
      setProgress(0);
    }
  }

  async function handleCidSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cidInput || !cidTitle) return;
    setDuplicate(null);
    setCidNotFound(null);
    if (cidThumbPinning) {
      toast("Waiting for thumbnail to finish pinning…");
      const start = Date.now();
      while (cidThumbPinning && Date.now() - start < 30_000) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    try {
      setCidStage("fetching");
      const result = await addCid({
        data: {
          wallet: address ?? undefined,
          cid: cidInput.trim(),
          title: cidTitle,
          description: cidDescription,
          months,
          thumbnailCid: cidThumbnailCidRef.current ?? cidThumbnailCid ?? undefined,
          nsfw: cidNsfw,
        },
      });
      if (result.chainStatus === "stamp_failed") {
        toast.error("CID saved, but TXC stamp failed");
      } else {
        toast.success("CID registered");
      }
      if (!address) recordAnonUpload(result.cid, cidTitle);
      qc.invalidateQueries({ queryKey: ["recent-videos"] });
      navigate({ to: "/v/$cid", params: { cid: result.cid } });
    } catch (err) {
      console.error(err);
      const dup = parseDuplicateCidError(err);
      if (dup) {
        setDuplicate(dup);
        toast.error("Nice try — this CID is already claimed.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("CID_NOT_FOUND")) {
          const detail = msg.split("CID_NOT_FOUND:")[1] ?? "";
          setCidNotFound(detail || "We couldn't find that CID on IPFS.");
          toast.error("CID not found on IPFS");
        } else {
          toast.error(msg || "Failed to register CID");
        }
      }
      setCidStage("idle");
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl px-6 py-12 flex-1">
        <div className="font-mono text-xs text-primary mb-3">
          [ PAY-AS-YOU-GO · NO ACCOUNT REQUIRED ]
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Upload video</h1>
        <p className="text-muted-foreground mb-10">
          Pin to IPFS. Pay in TXC. Get an embeddable player and an on-chain
          timestamp receipt.
        </p>

        <Tabs
          value={tab}
          onValueChange={(v) => setActiveTab(v as TabKey)}
          className="w-full"
        >
          {duplicate && (
            <div className="mb-6 border-2 border-destructive/60 bg-destructive/5 rounded-sm p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-destructive mb-1">
                    [ ALREADY ON STREAM ]
                  </div>
                  <div className="font-bold mb-2">
                    "{duplicate.title}"
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    This exact content (CID match) was published by{" "}
                    <span className="font-mono text-foreground">
                      {shortWallet(duplicate.ownerWallet)}
                    </span>{" "}
                    on{" "}
                    {formatDate(duplicate.createdAt)}
                    . CIDs are content-addressed — same file, same ID, forever.
                    First wallet to stamp wins.
                  </p>
                  <Link
                    to="/v/$cid"
                    params={{ cid: duplicate.cid }}
                    className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                  >
                    → view the original
                  </Link>
                </div>
              </div>
            </div>
          )}
          <TabsList className="grid w-full grid-cols-4 mb-6">
            <TabsTrigger value="file" className="font-mono text-xs">
              <Upload className="mr-2 h-3 w-3" /> Upload file
            </TabsTrigger>
            <TabsTrigger value="cid" className="font-mono text-xs">
              <Link2 className="mr-2 h-3 w-3" /> Add by CID
            </TabsTrigger>
            <TabsTrigger value="dropbox" className="font-mono text-xs">
              <Cloud className="mr-2 h-3 w-3" /> Dropbox
            </TabsTrigger>
            <TabsTrigger value="import" className="font-mono text-xs">
              <Sparkles className="mr-2 h-3 w-3" /> Import URL
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file">
        <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label className="font-mono text-xs">VIDEO FILE</Label>
              <label
                className={`block border-2 border-dashed rounded-sm p-8 cursor-pointer transition-colors bg-card ${
                  isDragging
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!isDragging) setIsDragging(true);
                }}
                onDragEnter={(e) => {
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
                  if (!f) return;
                  if (!f.type.startsWith("video/") && !/\.(mp4|webm|mov|m4v)$/i.test(f.name)) {
                    toast.error("Please drop a video file (mp4, webm, mov)");
                    return;
                  }
                  acceptFile(f);
                }}
              >
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) acceptFile(f);
                  }}
                />
                {file ? (
                  <div className="flex items-center gap-4">
                    <FileVideo className="h-8 w-8 text-primary" />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm truncate">
                        {file.name}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {formatBytes(file.size)} · {file.type || "video/mp4"}
                      </div>
                    </div>
                    {tooBig && (
                      <span className="font-mono text-xs text-destructive">
                        OVER 100 MB
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-center">
                    <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <div className="font-mono text-sm">
                      {isDragging ? "drop to upload" : "drag & drop or click to choose a video"}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground mt-1">
                      mp4 / webm / mov · max {formatBytes(MAX_UPLOAD_BYTES)}
                    </div>
                  </div>
                )}
              </label>
              <p className="font-mono text-[11px] text-muted-foreground">
                Larger files? Pin to IPFS first (e.g.{" "}
                <a
                  href="https://pinata.cloud"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  pinata.cloud
                </a>
                ) and use the <span className="text-foreground">Add by CID</span> tab.
              </p>
            </div>

            {tooBig && (
              <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0 space-y-3">
                    <div className="font-mono text-xs text-destructive">
                      [ FILE OVER 100 MB — DIRECT UPLOAD NOT SUPPORTED ]
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Pin your file to IPFS first, then paste its CID into{" "}
                      <span className="text-foreground">Add by CID</span> below.
                      We recommend{" "}
                      <a
                        href="https://pinata.cloud"
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        pinata.cloud
                      </a>{" "}
                      — their free tier covers most uploads.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="font-mono"
                      onClick={() => {
                        if (file && !cidTitle) {
                          setCidTitle(file.name.replace(/\.[^.]+$/, ""));
                        }
                        setActiveTab("cid");
                      }}
                    >
                      <Link2 className="mr-2 h-4 w-4" />
                      Switch to Add by CID
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {codecWarning && (
              <div className="border-2 border-amber-500/60 bg-amber-500/5 rounded-sm p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="font-mono text-xs text-amber-500">
                      [ MAY NOT PLAY IN BROWSERS ]
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {codecWarning}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-mono text-foreground">Heads up:</span>{" "}
                      converting changes the file's CID. If you want the on-chain
                      CID to match your original master file, upload the original
                      and accept that browsers may not decode it. Otherwise,
                      convert to MP4/H.264 first — the new MP4 gets its own CID
                      that everyone can play.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Quick convert (FFmpeg):{" "}
                      <code className="font-mono text-foreground bg-card px-1 py-0.5 rounded">
                        ffmpeg -i input.mov -c:v libx264 -crf 20 -c:a aac output.mp4
                      </code>
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="title" className="font-mono text-xs">TITLE</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
                className="font-mono"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description" className="font-mono text-xs">DESCRIPTION (optional)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={3}
              />
            </div>

            {file && !tooBig && (
              <ThumbnailPicker
                file={file}
                onChange={setThumbnailCid}
                onPinningChange={setThumbPinning}
              />
            )}

            <label className="flex items-start gap-3 border border-border bg-card rounded-sm p-4 cursor-pointer hover:border-primary/60 transition-colors">
              <Checkbox
                checked={nsfw}
                onCheckedChange={(v) => setNsfw(v === true)}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-foreground">
                  [ NSFW / ADULT CONTENT ]
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Mark this if your video contains nudity, sexual content, or
                  other adult material. NSFW videos are hidden from the
                  homepage and public listings — only people with the direct
                  link (or your <span className="font-mono text-foreground">/u/</span> page) can find them.
                </p>
              </div>
            </label>

            {file && !tooBig && (
              <div className="border border-border bg-card rounded-sm p-4 space-y-3 font-mono text-sm">
                <div className="flex justify-between items-start gap-4">
                  <span className="text-muted-foreground shrink-0">cid</span>
                  <span className="text-foreground text-xs break-all text-right">
                    {matchedCid ?? localCids?.v1 ?? (
                      <span className="text-muted-foreground inline-flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        hashing…
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">on ipfs?</span>
                  {cidProbe === "checking" || cidProbe === "idle" ? (
                    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      checking…
                    </span>
                  ) : cidProbe === "on-ipfs" ? (
                    <span className="text-primary inline-flex items-center gap-1.5 text-xs">
                      <CheckCircle2 className="h-3 w-3" />
                      already pinned — no upload needed
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-xs">no — will upload</span>
                  )}
                </div>
                <div className="flex justify-between items-center border-t border-border pt-3">
                  <span className="text-muted-foreground">cost · 1 month</span>
                  {quote ? (
                    <span className="text-right">
                      <span className="text-primary font-bold">
                        {formatTxc(quote.txcAmount)}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        ≈ ${quote.usdAmount.toFixed(4)} @ ${quote.txcUsd.toFixed(4)}/TXC
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      pricing…
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  $0.001 / MB / month, paid in TXC. After publishing you'll get a
                  per-video TXC address — send the amount above within 24h or
                  the file is unpinned.
                </p>
              </div>
            )}

            {stage === "uploading" && (
              <div className="space-y-2">
                <Progress value={progress} />
                <div className="font-mono text-xs text-muted-foreground text-right">
                  {progress.toFixed(0)}% · uploading directly to IPFS
                </div>
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              disabled={!file || !title || tooBig || stage !== "idle" || thumbPinning}
              className="w-full font-mono"
            >
              {stage === "idle" && (
                thumbPinning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Pinning thumbnail…
                  </>
                ) : cidProbe === "on-ipfs" ? (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Publish your video
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    Upload to IPFS & publish
                  </>
                )
              )}
              {stage !== "idle" && (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {stage === "hashing" && "Hashing file…"}
                  {stage === "checking" && "Checking IPFS for this file…"}
                  {stage === "uploading" && `Uploading ${progress.toFixed(0)}%…`}
                  {stage === "registering" && "Finalizing…"}
                </>
              )}
            </Button>
        </form>
          </TabsContent>

          <TabsContent value="cid">
            <form onSubmit={handleCidSubmit} className="space-y-6">
              {cidNotFound && (
                <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-destructive mb-1">
                        [ CID NOT FOUND ON IPFS ]
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {cidNotFound} Make sure the file is pinned somewhere
                        public (Pinata, web3.storage, your own node) and try
                        again. Fresh CIDs can take a minute to propagate.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="cid" className="font-mono text-xs">IPFS CID</Label>
                <Input
                  id="cid"
                  value={cidInput}
                  onChange={(e) => setCidInput(e.target.value)}
                  placeholder="bafy… or Qm…"
                  required
                  className="font-mono"
                />
                <p className="font-mono text-xs text-muted-foreground">
                  Already pinned somewhere? Register the CID and get a player + embed.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cid-title" className="font-mono text-xs">TITLE</Label>
                <Input
                  id="cid-title"
                  value={cidTitle}
                  onChange={(e) => setCidTitle(e.target.value)}
                  required
                  maxLength={200}
                  className="font-mono"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="cid-description" className="font-mono text-xs">DESCRIPTION (optional)</Label>
                <Textarea
                  id="cid-description"
                  value={cidDescription}
                  onChange={(e) => setCidDescription(e.target.value)}
                  maxLength={2000}
                  rows={3}
                />
              </div>

              <label className="flex items-start gap-3 border border-border bg-card rounded-sm p-4 cursor-pointer hover:border-primary/60 transition-colors">
                <Checkbox
                  checked={cidNsfw}
                  onCheckedChange={(v) => setCidNsfw(v === true)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-foreground">
                    [ NSFW / ADULT CONTENT ]
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Hide this video from the homepage and public listings.
                    Direct links still work.
                  </p>
                </div>
              </label>

              {/^(bafy|bafk|bafyb|Qm)/i.test(cidInput.trim()) &&
                cidInput.trim().length >= 46 && (
                  <ThumbnailPicker
                    key={cidInput.trim()}
                    videoSrc={`/api/stream/${cidInput.trim()}`}
                    onChange={setCidThumbnailCid}
                    onPinningChange={setCidThumbPinning}
                  />
                )}

              {cidStage !== "idle" && (
                <div className="border border-primary/40 bg-primary/5 rounded-sm p-4 space-y-2">
                  <div className="flex items-center gap-2 font-mono text-xs text-primary">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {cidStage === "fetching"
                      ? "Asking Pinata to fetch from IPFS…"
                      : "Stamping on TXC…"}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Cold CIDs can take 20–30 seconds while the IPFS DHT
                    locates a peer that has the file. Hang tight.
                  </p>
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                disabled={!cidInput || !cidTitle || cidStage !== "idle"}
                className="w-full font-mono"
              >
                {cidStage === "idle" ? (
                  <>
                    <Link2 className="mr-2 h-4 w-4" />
                    Register CID
                  </>
                ) : (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {cidStage === "fetching" ? "Fetching from IPFS…" : "Stamping…"}
                  </>
                )}
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="import">
            <UrlImportTab
              ownerWallet={address ?? null}
              onDuplicate={(info) => setDuplicate(info)}
              mode="url"
            />
          </TabsContent>

          <TabsContent value="dropbox">
            <UrlImportTab
              ownerWallet={address ?? null}
              onDuplicate={(info) => setDuplicate(info)}
              mode="dropbox"
            />
          </TabsContent>
        </Tabs>
      </main>
      <Footer />
    </div>
  );
}