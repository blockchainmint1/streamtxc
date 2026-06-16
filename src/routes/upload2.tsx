import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { useWallet } from "@/lib/wallet";
import { formatBytes, MAX_UPLOAD_BYTES } from "@/lib/fees";
import {
  registerUpload,
  lookupPinnedCid,
} from "@/lib/videos.functions";
import {
  getTranscodeUploadUrl,
  startTranscode,
  isTranscodeConfigured,
  getTranscodeStatus,
} from "@/lib/transcode.functions";
import { computeCids } from "@/lib/ipfs-cid";
import { ThumbnailPicker } from "@/components/ThumbnailPicker";
import { recordAnonUpload } from "@/lib/anon-uploads";
import {
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  FileVideo,
  Circle,
  ArrowRight,
  Cloud,
  Film,
  Anchor,
  Network,
  PartyPopper,
} from "lucide-react";
import { toast } from "sonner";
import { parseDuplicateCidError, type DuplicateCidInfo } from "@/lib/duplicate-cid";

export const Route = createFileRoute("/upload2")({
  head: () => ({
    meta: [
      { title: "Upload v2 (HLS pipeline) — streamTXC" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Upload2Page,
});

function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const cleanBase =
    base
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/[^A-Za-z0-9._\-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "video";
  return cleanBase + ext.replace(/[^A-Za-z0-9.]/g, "").slice(0, 10);
}

// XHR upload so we get progress events (fetch can't stream PUT progress).
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`S3 PUT failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`));
    };
    xhr.onerror = () => reject(new Error("Network error during S3 upload"));
    xhr.send(file);
  });
}

// POST to our Worker → Pinata (existing pipeline). Same as /upload.
function postToPinataViaWorker(
  file: File,
  filename: string,
  onProgress: (pct: number) => void,
): Promise<{ cid: string; size: number }> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("filename", filename);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/public/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText) as { cid?: string; size?: number; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && json.cid) {
          resolve({ cid: json.cid, size: json.size ?? file.size });
        } else {
          reject(new Error(json.error || `Pinata upload failed (${xhr.status})`));
        }
      } catch {
        reject(new Error(`Pinata upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during Pinata upload"));
    xhr.send(form);
  });
}

type StageKey =
  | "prepare"
  | "pin-original"
  | "s3-upload"
  | "register"
  | "transcode"
  | "pin-hls"
  | "done";

type StageState = "pending" | "active" | "done" | "skipped" | "error";

interface StageRow {
  key: StageKey;
  label: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STAGES: StageRow[] = [
  { key: "prepare", label: "Prepare", blurb: "Hash file, compute CID, quote", icon: Circle },
  { key: "pin-original", label: "Pin original to IPFS", blurb: "Pinata pins the master file", icon: Cloud },
  { key: "s3-upload", label: "Upload to S3", blurb: "Push to MediaConvert input bucket", icon: Upload },
  { key: "register", label: "Register video", blurb: "Write row + stamp TXC chain", icon: Anchor },
  { key: "transcode", label: "Transcode (HLS)", blurb: "MediaConvert builds multi-bitrate ladder", icon: Film },
  { key: "pin-hls", label: "Pin HLS bundle to IPFS", blurb: "Webhook re-anchors HLS directory CID", icon: Network },
  { key: "done", label: "Ready to stream", blurb: "Adaptive HLS available on /v2/CID", icon: PartyPopper },
];

function Upload2Page() {
  const qc = useQueryClient();
  const { address } = useWallet();
  const register = useServerFn(registerUpload);
  const lookupCid = useServerFn(lookupPinnedCid);
  const getS3Url = useServerFn(getTranscodeUploadUrl);
  const startTx = useServerFn(startTranscode);
  const checkConfig = useServerFn(isTranscodeConfigured);
  const checkStatus = useServerFn(getTranscodeStatus);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [thumbnailCid, setThumbnailCid] = useState<string | null>(null);
  const [nsfw, setNsfw] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [stages, setStages] = useState<Record<StageKey, StageState>>({
    prepare: "pending",
    "pin-original": "pending",
    "s3-upload": "pending",
    register: "pending",
    transcode: "pending",
    "pin-hls": "pending",
    done: "pending",
  });
  const [stageDetail, setStageDetail] = useState<Partial<Record<StageKey, string>>>({});
  const [running, setRunning] = useState(false);
  const [s3Progress, setS3Progress] = useState(0);
  const [pinProgress, setPinProgress] = useState(0);
  const [resultCid, setResultCid] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateCidInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

  function setStage(key: StageKey, state: StageState, detail?: string) {
    setStages((s) => ({ ...s, [key]: state }));
    if (detail !== undefined) {
      setStageDetail((d) => ({ ...d, [key]: detail }));
    }
  }

  function acceptFile(f: File) {
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    setThumbnailCid(null);
  }

  // Poll transcode status once a CID exists.
  useEffect(() => {
    if (!resultCid) return;
    let cancelled = false;
    async function tick() {
      try {
        const row = await checkStatus({ data: { cid: resultCid! } });
        if (cancelled) return;
        const st = row?.transcode_status;
        if (st === "processing") {
          setStage("transcode", "active", `job ${row?.transcode_job_id ?? "?"}`);
        } else if (st === "complete") {
          setStage("transcode", "done");
          setStage("pin-hls", "done", row?.hls_cid ? `hls cid: ${row.hls_cid}` : undefined);
          setStage("done", "done");
          if (pollRef.current) window.clearInterval(pollRef.current);
          return;
        } else if (st === "failed") {
          setStage("transcode", "error", row?.transcode_error ?? "MediaConvert reported failure");
          if (pollRef.current) window.clearInterval(pollRef.current);
          return;
        }
      } catch (err) {
        // ignore transient
      }
    }
    void tick();
    pollRef.current = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [resultCid, checkStatus]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !title || tooBig || running) return;
    setRunning(true);
    setError(null);
    setDuplicate(null);
    setResultCid(null);
    setS3Progress(0);
    setPinProgress(0);
    setStages({
      prepare: "pending",
      "pin-original": "pending",
      "s3-upload": "pending",
      register: "pending",
      transcode: "pending",
      "pin-hls": "pending",
      done: "pending",
    });
    setStageDetail({});

    try {
      // 1. Prepare
      setStage("prepare", "active");
      const cids = await computeCids(file);
      setStage("prepare", "done", `cid v1: ${cids.v1.slice(0, 14)}…`);

      // Detect duplicate / already-pinned before paying for double upload.
      const hit = await lookupCid({ data: { cidV1: cids.v1, cidV0: cids.v0 } });
      if (hit) {
        // Already pinned to Pinata. Still need to push to S3 for transcoding.
        setStage("pin-original", "skipped", "Already pinned to IPFS");
      }

      // 2. Pin original via Worker → Pinata (if not already pinned).
      let pinnedCid = hit?.cid ?? null;
      let pinnedSize = file.size;
      if (!pinnedCid) {
        setStage("pin-original", "active");
        const safeName = sanitizeFilename(file.name);
        const r = await postToPinataViaWorker(file, safeName, setPinProgress);
        pinnedCid = r.cid;
        pinnedSize = r.size;
        setStage("pin-original", "done", `cid: ${pinnedCid.slice(0, 14)}…`);
      }

      // 3. Upload same bytes to S3 (only if AWS configured).
      const { configured } = await checkConfig();
      if (configured) {
        setStage("s3-upload", "active");
        const ct = file.type || "video/mp4";
        const { url, bucket, key } = await getS3Url({ data: { cid: pinnedCid, contentType: ct } });
        await putWithProgress(url, file, ct, setS3Progress);
        setStage("s3-upload", "done", `s3://${bucket}/${key}`);
      } else {
        setStage("s3-upload", "skipped", "AWS pipeline not provisioned yet");
      }

      // 4. Register video row + stamp chain.
      setStage("register", "active");
      const result = await register({
        data: {
          wallet: address ?? undefined,
          cid: pinnedCid,
          title,
          description,
          sizeBytes: pinnedSize || file.size,
          mimeType: file.type || "video/mp4",
          months: 1,
          thumbnailCid: thumbnailCid ?? undefined,
          nsfw,
        },
      });
      setStage(
        "register",
        "done",
        result.chainStatus === "stamp_failed"
          ? "Saved row · chain stamp queued for retry"
          : "Row saved · TXC stamp broadcast",
      );
      if (!address) recordAnonUpload(result.cid, title);
      qc.invalidateQueries({ queryKey: ["recent-videos"] });
      setResultCid(result.cid);

      // 5. Kick off MediaConvert (gated on config).
      if (configured) {
        setStage("transcode", "active", "queueing MediaConvert job…");
        try {
          const { jobId } = await startTx({ data: { cid: pinnedCid } });
          setStage("transcode", "active", `job ${jobId}`);
          setStage("pin-hls", "active", "waiting for webhook…");
        } catch (err) {
          setStage(
            "transcode",
            "error",
            err instanceof Error ? err.message : "Could not start transcode",
          );
        }
      } else {
        setStage("transcode", "skipped", "AWS pipeline not provisioned yet");
        setStage("pin-hls", "skipped");
        setStage("done", "done", "Original is live; HLS will come online once AWS is up");
      }
    } catch (err) {
      console.error(err);
      const dup = parseDuplicateCidError(err);
      if (dup) {
        setDuplicate(dup);
        toast.error("This video is already on stream.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl px-6 py-12 flex-1 space-y-8">
        <div>
          <div className="font-mono text-xs text-primary mb-3">
            [ V2 UPLOAD · HLS PIPELINE · EXPERIMENTAL ]
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-2">Upload (v2)</h1>
          <p className="text-muted-foreground">
            Pin the original to IPFS, push to S3, transcode to multi-bitrate HLS
            on MediaConvert, then pin the HLS bundle back to IPFS. Each step
            below lights up as it runs.
          </p>
        </div>

        {duplicate && (
          <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-destructive mb-1">
                  [ ALREADY ON STREAM ]
                </div>
                <div className="font-bold mb-2">"{duplicate.title}"</div>
                <Link
                  to="/v2/$cid"
                  params={{ cid: duplicate.cid }}
                  className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                >
                  → view the original on v2
                </Link>
              </div>
            </div>
          </div>
        )}

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
              onDragLeave={(e) => {
                e.preventDefault();
                setIsDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) acceptFile(f);
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
                    <div className="font-mono text-sm truncate">{file.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {formatBytes(file.size)} · {file.type || "video/mp4"}
                    </div>
                  </div>
                  {tooBig && (
                    <span className="font-mono text-xs text-destructive">OVER 100 MB</span>
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
          </div>

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
            <ThumbnailPicker file={file} onChange={setThumbnailCid} />
          )}

          <label className="flex items-start gap-3 border border-border bg-card rounded-sm p-4 cursor-pointer">
            <Checkbox checked={nsfw} onCheckedChange={(v) => setNsfw(v === true)} className="mt-0.5" />
            <div className="flex-1">
              <div className="font-mono text-xs">[ NSFW / ADULT CONTENT ]</div>
              <p className="text-xs text-muted-foreground mt-1">
                Hidden from homepage and public listings.
              </p>
            </div>
          </label>

          <Button
            type="submit"
            disabled={!file || !title || tooBig || running}
            className="w-full font-mono"
            size="lg"
          >
            {running ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running pipeline…</>
            ) : (
              <>Start v2 pipeline <ArrowRight className="ml-2 h-4 w-4" /></>
            )}
          </Button>
        </form>

        {(running || resultCid || error) && (
          <StageTracker
            stages={stages}
            detail={stageDetail}
            s3Progress={s3Progress}
            pinProgress={pinProgress}
          />
        )}

        {resultCid && (
          <div className="border border-primary/40 bg-primary/5 rounded-sm p-5 space-y-3">
            <div className="flex items-center gap-2 font-mono text-xs text-primary">
              <CheckCircle2 className="h-4 w-4" />
              [ VIDEO REGISTERED · CID {resultCid.slice(0, 16)}… ]
            </div>
            <p className="text-sm text-muted-foreground">
              The original is live now. HLS playback will appear on the v2
              page as soon as MediaConvert finishes and the webhook pins the
              bundle back to IPFS.
            </p>
            <div className="flex gap-2 flex-wrap">
              <Link to="/v2/$cid" params={{ cid: resultCid }}>
                <Button size="sm" className="font-mono">
                  Watch on v2 <ArrowRight className="ml-2 h-3 w-3" />
                </Button>
              </Link>
              <Link to="/v/$cid" params={{ cid: resultCid }}>
                <Button size="sm" variant="outline" className="font-mono">
                  Watch on v1 (legacy)
                </Button>
              </Link>
            </div>
          </div>
        )}

        {error && (
          <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-4 font-mono text-xs text-destructive whitespace-pre-wrap">
            {error}
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

function StageTracker({
  stages,
  detail,
  s3Progress,
  pinProgress,
}: {
  stages: Record<StageKey, StageState>;
  detail: Partial<Record<StageKey, string>>;
  s3Progress: number;
  pinProgress: number;
}) {
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-card font-mono text-xs text-primary">
        [ PIPELINE ]
      </div>
      <ol className="divide-y divide-border">
        {STAGES.map((s) => {
          const state = stages[s.key];
          const Icon = s.icon;
          return (
            <li key={s.key} className="px-4 py-3 flex items-start gap-3">
              <StageIcon state={state} Icon={Icon} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      "font-mono text-sm " +
                      (state === "done"
                        ? "text-primary"
                        : state === "active"
                        ? "text-foreground"
                        : state === "error"
                        ? "text-destructive"
                        : state === "skipped"
                        ? "text-muted-foreground line-through"
                        : "text-muted-foreground")
                    }
                  >
                    {s.label}
                  </span>
                  <StageBadge state={state} />
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {detail[s.key] ?? s.blurb}
                </div>
                {s.key === "pin-original" && state === "active" && (
                  <Progress value={pinProgress} className="h-1 mt-1" />
                )}
                {s.key === "s3-upload" && state === "active" && (
                  <Progress value={s3Progress} className="h-1 mt-1" />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StageIcon({
  state,
  Icon,
}: {
  state: StageState;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  if (state === "done") return <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />;
  if (state === "active") return <Loader2 className="h-5 w-5 animate-spin text-amber-500 shrink-0 mt-0.5" />;
  if (state === "error") return <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />;
  if (state === "skipped") return <Circle className="h-5 w-5 text-muted-foreground/40 shrink-0 mt-0.5" />;
  return <Icon className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />;
}

function StageBadge({ state }: { state: StageState }) {
  const map: Record<StageState, { text: string; cls: string }> = {
    pending: { text: "pending", cls: "text-muted-foreground border-border" },
    active: { text: "running", cls: "text-amber-500 border-amber-500/50" },
    done: { text: "done", cls: "text-primary border-primary/50" },
    skipped: { text: "skipped", cls: "text-muted-foreground border-border" },
    error: { text: "error", cls: "text-destructive border-destructive/60" },
  };
  const m = map[state];
  return (
    <span className={`font-mono text-[10px] uppercase tracking-wider border px-1.5 py-0.5 rounded-sm ${m.cls}`}>
      {m.text}
    </span>
  );
}