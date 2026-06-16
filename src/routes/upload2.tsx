import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
  getMediaConvertJob,
  simulateMediaConvertWebhook,
} from "@/lib/transcode.functions";
import {
  pinS3ToIpfs,
  ipfsLambdaHealth,
  isIpfsLambdaConfigured,
} from "@/lib/ipfs-lambda.functions";
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
  Terminal,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { parseDuplicateCidError, type DuplicateCidInfo } from "@/lib/duplicate-cid";

export const Route = createFileRoute("/upload2")({
  head: () => ({
    meta: [
      { title: "Upload v3 (S3 → self-hosted IPFS) — streamTXC" },
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

type StageKey =
  | "prepare"
  | "s3-upload"
  | "pin-ipfs"
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
  { key: "prepare", label: "Prepare", blurb: "Hash file, compute v1 CID, dedupe check", icon: Circle },
  { key: "s3-upload", label: "Upload to S3", blurb: "Browser PUTs file to AWS S3 (presigned)", icon: Upload },
  { key: "pin-ipfs", label: "Pin S3 → self-hosted IPFS", blurb: "Lambda streams S3 object into kubo node", icon: Cloud },
  { key: "register", label: "Register video", blurb: "Write row + stamp TXC chain", icon: Anchor },
  { key: "transcode", label: "Transcode (HLS)", blurb: "MediaConvert builds multi-bitrate ladder", icon: Film },
  { key: "pin-hls", label: "Pin HLS bundle to IPFS", blurb: "Webhook re-anchors HLS directory CID", icon: Network },
  { key: "done", label: "Ready to stream", blurb: "Adaptive HLS available on /v2/CID", icon: PartyPopper },
];

type LogLevel = "info" | "ok" | "warn" | "err" | "step";
interface LogLine {
  t: number;            // ms since pipeline start
  level: LogLevel;
  msg: string;
}

function Upload2Page() {
  const qc = useQueryClient();
  const { address } = useWallet();
  const navigate = useNavigate();
  const register = useServerFn(registerUpload);
  const lookupCid = useServerFn(lookupPinnedCid);
  const getS3Url = useServerFn(getTranscodeUploadUrl);
  const startTx = useServerFn(startTranscode);
  const checkConfig = useServerFn(isTranscodeConfigured);
  const checkStatus = useServerFn(getTranscodeStatus);
  const describeJob = useServerFn(getMediaConvertJob);
  const runWebhook = useServerFn(simulateMediaConvertWebhook);
  const pinFromS3 = useServerFn(pinS3ToIpfs);
  const checkIpfs = useServerFn(isIpfsLambdaConfigured);
  const probeIpfs = useServerFn(ipfsLambdaHealth);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [thumbnailCid, setThumbnailCid] = useState<string | null>(null);
  const [nsfw, setNsfw] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [stages, setStages] = useState<Record<StageKey, StageState>>({
    prepare: "pending",
    "s3-upload": "pending",
    "pin-ipfs": "pending",
    register: "pending",
    transcode: "pending",
    "pin-hls": "pending",
    done: "pending",
  });
  const [stageDetail, setStageDetail] = useState<Partial<Record<StageKey, string>>>({});
  const [running, setRunning] = useState(false);
  const [s3Progress, setS3Progress] = useState(0);
  const [resultCid, setResultCid] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateCidInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [autoNavigate, setAutoNavigate] = useState(true);
  const pollRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

  const pushLog = useCallback((level: LogLevel, msg: string) => {
    const t = startTimeRef.current
      ? Date.now() - startTimeRef.current
      : 0;
    setLog((prev) => [...prev, { t, level, msg }]);
    // Mirror to devtools console for offline inspection.
    const tag = `[upload2:${level}]`;
    if (level === "err") console.error(tag, msg);
    else if (level === "warn") console.warn(tag, msg);
    else console.log(tag, msg);
  }, []);

  // Auto-scroll the log to the bottom.
  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [log]);

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
    let pinTriggered = false;
    async function tick() {
      try {
        const row = await checkStatus({ data: { cid: resultCid! } });
        if (cancelled) return;
        const st = row?.transcode_status;
        if (st === "processing") {
          setStage("transcode", "active", `job ${row?.transcode_job_id ?? "?"}`);
          pushLog("info", `transcode poll → processing (job ${row?.transcode_job_id ?? "?"})`);
          // Fallback: EventBridge webhook may not have fired. Check AWS
          // directly; if the job is COMPLETE, run the pin/anchor inline.
          const jobId = row?.transcode_job_id;
          if (jobId && !pinTriggered) {
            try {
              const job = await describeJob({ data: { jobId } });
              const awsStatus = (job as { status?: string } | null)?.status;
              if (awsStatus === "COMPLETE") {
                pinTriggered = true;
                pushLog("step", `AWS reports COMPLETE — webhook missed, pinning HLS bundle inline…`);
                setStage("pin-hls", "active", "pinning HLS bundle (fallback path)");
                const res = await runWebhook({ data: { cid: resultCid!, jobId } });
                pushLog("ok", `inline pin done (${res.status})`);
              } else if (awsStatus === "ERROR") {
                pushLog("err", `AWS job ${jobId} ERROR`);
              }
            } catch (err) {
              pinTriggered = false;
              pushLog("warn", `AWS describeJob failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (st === "complete" || st === "ready") {
          setStage("transcode", "done");
          setStage("pin-hls", "done", row?.hls_cid ? `hls cid: ${row.hls_cid}` : undefined);
          setStage("done", "done");
          pushLog("ok", `transcode COMPLETE · hls cid: ${row?.hls_cid ?? "(missing)"}`);
          pushLog("step", `pipeline complete — /v2/${resultCid}`);
          if (pollRef.current) window.clearInterval(pollRef.current);
          if (autoNavigate && resultCid) {
            pushLog("info", "auto-navigating to /v2 in 1500ms…");
            window.setTimeout(() => {
              void navigate({ to: "/v2/$cid", params: { cid: resultCid } });
            }, 1500);
          }
          return;
        } else if (st === "failed") {
          setStage("transcode", "error", row?.transcode_error ?? "MediaConvert reported failure");
          pushLog("err", `transcode FAILED: ${row?.transcode_error ?? "no error message"}`);
          if (pollRef.current) window.clearInterval(pollRef.current);
          return;
        }
      } catch (err) {
        pushLog("warn", `transcode poll error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    void tick();
    pollRef.current = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [resultCid, checkStatus, pushLog, navigate, autoNavigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !title || tooBig || running) return;
    startTimeRef.current = Date.now();
    setLog([]);
    setRunning(true);
    setError(null);
    setDuplicate(null);
    setResultCid(null);
    setS3Progress(0);
    setStages({
      prepare: "pending",
      "s3-upload": "pending",
      "pin-ipfs": "pending",
      register: "pending",
      transcode: "pending",
      "pin-hls": "pending",
      done: "pending",
    });
    setStageDetail({});

    try {
      pushLog("step", `▶ pipeline v3 starting · ${file.name} · ${formatBytes(file.size)} · ${file.type || "video/mp4"}`);

      // 0. Preflight — verify AWS + Lambda are reachable.
      pushLog("info", "checking AWS + IPFS Lambda configuration…");
      const [{ configured: awsConfigured }, ipfsCfg] = await Promise.all([
        checkConfig(),
        checkIpfs(),
      ]);
      pushLog(awsConfigured ? "ok" : "err", `aws transcode configured: ${awsConfigured}`);
      pushLog(ipfsCfg.configured ? "ok" : "err", `ipfs lambda configured: ${ipfsCfg.configured}${ipfsCfg.gateway ? ` · gateway: ${ipfsCfg.gateway}` : ""}`);
      if (!awsConfigured) throw new Error("AWS transcode pipeline not configured — set AWS_* env vars.");
      if (!ipfsCfg.configured) throw new Error("IPFS Lambda not configured — set IPFS_LAMBDA_URL + IPFS_LAMBDA_TOKEN.");

      const health = await probeIpfs();
      pushLog(health.ok ? "ok" : "warn", `ipfs lambda /health → ${health.ok ? "ok" : "fail"} ${typeof health.body === "string" ? health.body : ""}`);
      if (!health.ok) {
        pushLog("warn", `health body: ${("reason" in health && health.reason) || ""}`);
      }

      // 1. Prepare — hash file, compute CIDs for dedupe.
      setStage("prepare", "active");
      pushLog("info", "computing local CIDv1 + CIDv0 (this hashes the whole file)…");
      const tCid = Date.now();
      const cids = await computeCids(file);
      pushLog("ok", `cid v1: ${cids.v1}`);
      pushLog("info", `cid v0: ${cids.v0} (legacy hash)`);
      pushLog("info", `local CID hashing took ${Date.now() - tCid}ms`);
      setStage("prepare", "done", `cid v1: ${cids.v1.slice(0, 14)}…`);

      // Dedupe — has this CID been uploaded before?
      pushLog("info", "checking videos table for an existing row with this CID…");
      const hit = await lookupCid({ data: { cidV1: cids.v1, cidV0: cids.v0 } });
      if (hit) {
        pushLog("warn", `duplicate hit: video already exists with cid ${hit.cid}`);
      } else {
        pushLog("ok", "no existing video found — fresh upload");
      }

      // 2. S3 upload — push the file to the MediaConvert input bucket.
      setStage("s3-upload", "active");
      const ct = file.type || "video/mp4";
      pushLog("info", `requesting presigned S3 PUT for content-type=${ct}…`);
      const { url: s3Url, bucket, key } = await getS3Url({
        data: { cid: cids.v1, contentType: ct },
      });
      pushLog("ok", `presigned url received · bucket=${bucket} · key=${key}`);
      pushLog("info", `uploading ${formatBytes(file.size)} to s3://${bucket}/${key}…`);
      const tUp = Date.now();
      await putWithProgress(s3Url, file, ct, (p) => {
        setS3Progress(p);
      });
      const upMs = Date.now() - tUp;
      const mbps = ((file.size / (1024 * 1024)) / (upMs / 1000)).toFixed(2);
      pushLog("ok", `S3 PUT complete in ${upMs}ms (${mbps} MiB/s)`);
      setStage("s3-upload", "done", `s3://${bucket}/${key}`);

      // 3. Pin S3 → self-hosted IPFS via Lambda.
      setStage("pin-ipfs", "active");
      pushLog("info", `calling IPFS Lambda POST /pin · bucket=${bucket} · keys=[${key}]…`);
      const tPin = Date.now();
      const pinned = await pinFromS3({
        data: { bucket, keys: [key] },
      });
      pushLog("ok", `lambda responded in ${Date.now() - tPin}ms · server-measured: ${pinned.durationMs}ms`);
      pushLog("info", `wrap dir cid: ${pinned.wrapCid}`);
      pushLog("info", `inner file cid: ${pinned.fileCid ?? "(none)"} · files: ${pinned.files} · bytes: ${pinned.totalBytes}`);
      for (const m of pinned.manifest.slice(0, 5)) {
        pushLog("info", `  · ${m.path} → ${m.cid} (${m.size}B)`);
      }

      // Sanity-check the inner CID matches the locally computed v1 CID.
      const canonicalCid = pinned.fileCid ?? cids.v1;
      if (pinned.fileCid && pinned.fileCid !== cids.v1) {
        pushLog("warn", `inner cid ${pinned.fileCid} != local cid ${cids.v1} — using inner. (chunker mismatch?)`);
      } else {
        pushLog("ok", `inner cid matches local v1 cid ✓`);
      }
      setStage("pin-ipfs", "done", `cid: ${canonicalCid.slice(0, 14)}… · wrap: ${pinned.wrapCid.slice(0, 14)}…`);

      if (ipfsCfg.gateway) {
        pushLog("info", `gateway URL: https://${ipfsCfg.gateway}/ipfs/${canonicalCid}`);
      }

      // 4. Register video row + stamp chain.
      setStage("register", "active");
      pushLog("info", `registering video row · title="${title}" · wallet=${address ?? "(anonymous)"}`);
      const tReg = Date.now();
      const result = await register({
        data: {
          wallet: address ?? undefined,
          cid: canonicalCid,
          title,
          description,
          sizeBytes: file.size,
          mimeType: file.type || "video/mp4",
          months: 1,
          thumbnailCid: thumbnailCid ?? undefined,
          nsfw,
        },
      });
      pushLog("ok", `register OK in ${Date.now() - tReg}ms · cid=${result.cid} · chainStatus=${result.chainStatus}`);
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

      // 5. Kick off MediaConvert.
      setStage("transcode", "active", "queueing MediaConvert job…");
      pushLog("info", "queueing MediaConvert HLS job…");
      try {
        const { jobId } = await startTx({ data: { cid: canonicalCid } });
        pushLog("ok", `MediaConvert job queued · jobId=${jobId}`);
        setStage("transcode", "active", `job ${jobId}`);
        setStage("pin-hls", "active", "waiting for MediaConvert webhook…");
        pushLog("step", "waiting for MediaConvert webhook (polling every 5s)…");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not start transcode";
        pushLog("err", `startTranscode failed: ${msg}`);
        setStage("transcode", "error", msg);
      }
    } catch (err) {
      console.error(err);
      const dup = parseDuplicateCidError(err);
      if (dup) {
        pushLog("err", `duplicate CID — already on stream as "${dup.title}" (cid ${dup.cid})`);
        setDuplicate(dup);
        toast.error("This video is already on stream.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("err", msg);
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setRunning(false);
      pushLog("step", "◼ pipeline run complete");
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl px-6 py-12 flex-1 space-y-8">
        <div>
          <div className="font-mono text-xs text-primary mb-3">
            [ V3 UPLOAD · S3 → SELF-HOSTED IPFS · VERBOSE ]
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-2">Upload (v3)</h1>
          <p className="text-muted-foreground">
            Pushes the file to S3 first, then asks our self-hosted IPFS
            Lambda to pin it directly from S3 (no Pinata in the hot path).
            MediaConvert builds an HLS ladder and the webhook pins the
            HLS bundle back to IPFS. Every step is logged verbosely below.
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
          <>
            <StageTracker
              stages={stages}
              detail={stageDetail}
              s3Progress={s3Progress}
            />
            <LogPanel log={log} boxRef={logBoxRef} />
          </>
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
              bundle back to IPFS. You'll be auto-redirected when it's ready.
            </p>
            <label className="flex items-center gap-2 font-mono text-xs">
              <Checkbox
                checked={autoNavigate}
                onCheckedChange={(v) => setAutoNavigate(v === true)}
              />
              auto-navigate to /v2/{resultCid.slice(0, 10)}… when HLS is ready
            </label>
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
}: {
  stages: Record<StageKey, StageState>;
  detail: Partial<Record<StageKey, string>>;
  s3Progress: number;
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

function LogPanel({
  log,
  boxRef,
}: {
  log: LogLine[];
  boxRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const copyAll = () => {
    const text = log
      .map((l) => `[+${(l.t / 1000).toFixed(2)}s] ${l.level.toUpperCase().padEnd(4)} ${l.msg}`)
      .join("\n");
    void navigator.clipboard?.writeText(text);
    toast.success("Log copied to clipboard");
  };
  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-card flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-xs text-primary">
          <Terminal className="h-3 w-3" />
          [ LIVE LOG · {log.length} LINES ]
        </div>
        <button
          type="button"
          onClick={copyAll}
          disabled={log.length === 0}
          className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-primary disabled:opacity-40 flex items-center gap-1"
        >
          <Copy className="h-3 w-3" /> copy
        </button>
      </div>
      <div
        ref={boxRef}
        className="bg-black text-green-300 font-mono text-[11px] leading-relaxed p-4 h-72 overflow-auto"
      >
        {log.length === 0 ? (
          <div className="text-muted-foreground">// no log entries yet</div>
        ) : (
          log.map((l, i) => {
            const color =
              l.level === "ok" ? "text-emerald-400"
              : l.level === "err" ? "text-red-400"
              : l.level === "warn" ? "text-amber-300"
              : l.level === "step" ? "text-cyan-300 font-bold"
              : "text-green-300";
            return (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">[+{(l.t / 1000).toFixed(2)}s]</span>{" "}
                <span className={color}>{l.level.toUpperCase().padEnd(4)}</span>{" "}
                <span className={color}>{l.msg}</span>
              </div>
            );
          })
        )}
      </div>
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