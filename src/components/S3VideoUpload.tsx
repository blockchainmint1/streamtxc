// Reusable S3 → IPFS Lambda → MediaConvert pipeline.
// Extracted from /upload so the page can use it inside a tab without
// duplicating ~600 lines of pipeline logic.

import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useWallet } from "@/lib/wallet";
import { getWallet } from "@/lib/wallet";
import { formatBytes, MAX_S3_UPLOAD_BYTES } from "@/lib/fees";
import {
  registerUpload,
  lookupPinnedCid,
  createUploadDraft,
  patchUploadDraft,
} from "@/lib/videos.functions";
import {
  getTranscodeUploadUrl,
  startTranscode,
  isTranscodeConfigured,
  getTranscodeStatus,
  getMediaConvertJob,
  checkS3InputExists,
  kickoffHlsFromCid,
} from "@/lib/transcode.functions";
import {
  pinS3ToIpfs,
  ipfsLambdaHealth,
  isIpfsLambdaConfigured,
  kickHlsPinAsync,
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
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import {
  parseDuplicateCidError,
  type DuplicateCidInfo,
} from "@/lib/duplicate-cid";

const INFLIGHT_KEY = "txc:upload-inflight";
interface InflightJob {
  cid: string;
  jobId?: string;
  startedAt: number;
}
function saveInflight(j: InflightJob) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(INFLIGHT_KEY, JSON.stringify(j)); } catch { /* ignore */ }
}
function readInflight(): InflightJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(INFLIGHT_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as InflightJob;
    if (!p || typeof p.cid !== "string") return null;
    if (Date.now() - (p.startedAt ?? 0) > 6 * 60 * 60 * 1000) return null;
    return p;
  } catch { return null; }
}
function clearInflight() {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(INFLIGHT_KEY); } catch { /* ignore */ }
}

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
  { key: "prepare", label: "Prepare", blurb: "Hash file, compute CID, dedupe check", icon: Circle },
  { key: "s3-upload", label: "Upload", blurb: "Browser uploads to AWS S3", icon: Upload },
  { key: "pin-ipfs", label: "Pin to IPFS", blurb: "Self-hosted IPFS node stores original", icon: Cloud },
  { key: "register", label: "Register on-chain", blurb: "Write row + stamp TXC chain", icon: Anchor },
  { key: "transcode", label: "Transcode HLS", blurb: "MediaConvert builds adaptive ladder", icon: Film },
  { key: "pin-hls", label: "Pin HLS bundle", blurb: "Webhook re-anchors HLS directory CID", icon: Network },
  { key: "done", label: "Ready to stream", blurb: "Adaptive HLS available", icon: PartyPopper },
];

type LogLevel = "info" | "ok" | "warn" | "err" | "step";
interface LogLine { t: number; level: LogLevel; msg: string; }

export interface S3VideoUploadProps {
  /** Default-collapse the verbose pipeline log. Default false. */
  showLogByDefault?: boolean;
  /** Route to send users to once their video is ready. Default /v/$cid. */
  destination?: "v" | "v2";
}

export function S3VideoUpload({
  showLogByDefault = true,
  destination = "v2",
}: S3VideoUploadProps) {
  const qc = useQueryClient();
  const { address } = useWallet();
  const navigate = useNavigate();
  const register = useServerFn(registerUpload);
  const lookupCid = useServerFn(lookupPinnedCid);
  const createDraft = useServerFn(createUploadDraft);
  const patchDraft = useServerFn(patchUploadDraft);
  const getS3Url = useServerFn(getTranscodeUploadUrl);
  const startTx = useServerFn(startTranscode);
  const preflightS3 = useServerFn(checkS3InputExists);
  const checkConfig = useServerFn(isTranscodeConfigured);
  const checkStatus = useServerFn(getTranscodeStatus);
  const describeJob = useServerFn(getMediaConvertJob);
  const kickPin = useServerFn(kickHlsPinAsync);
  const pinFromS3 = useServerFn(pinS3ToIpfs);
  const checkIpfs = useServerFn(isIpfsLambdaConfigured);
  const probeIpfs = useServerFn(ipfsLambdaHealth);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [thumbnailCid, setThumbnailCid] = useState<string | null>(null);
  const [nsfw, setNsfw] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // Draft row — created lazily on first patch so the chosen thumbnail
  // (and title/desc/NSFW) is persisted to the DB the moment the user
  // picks it. Finalize reads the draft so React state can't drop it.
  const draftRef = useRef<{ id: string; token: string } | null>(null);
  async function ensureDraft() {
    if (draftRef.current) return draftRef.current;
    const d = await createDraft({ data: { wallet: address ?? undefined } });
    draftRef.current = d;
    return d;
  }
  async function pushDraft(patch: {
    title?: string;
    description?: string;
    thumbnailCid?: string | null;
    nsfw?: boolean;
  }) {
    try {
      const d = await ensureDraft();
      await patchDraft({ data: { id: d.id, token: d.token, wallet: address ?? undefined, ...patch } });
    } catch (err) {
      console.error("draft patch failed", err);
    }
  }

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
  const [logOpen, setLogOpen] = useState(showLogByDefault);
  const pollRef = useRef<number | null>(null);
  const rekickRef = useRef<Set<string>>(new Set());
  const startTimeRef = useRef<number>(0);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  const tooBig = !!file && file.size > MAX_S3_UPLOAD_BYTES;

  const pushLog = useCallback((level: LogLevel, msg: string) => {
    const t = startTimeRef.current ? Date.now() - startTimeRef.current : 0;
    setLog((prev) => [...prev, { t, level, msg }]);
    const tag = `[upload:${level}]`;
    if (level === "err") console.error(tag, msg);
    else if (level === "warn") console.warn(tag, msg);
    else console.log(tag, msg);
  }, []);

  useEffect(() => {
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [log]);

  // Resume in-flight job from a previous tab/session.
  useEffect(() => {
    const inflight = readInflight();
    if (!inflight) return;
    let cancelled = false;
    (async () => {
      try {
        const row = await checkStatus({ data: { cid: inflight.cid } });
        if (cancelled) return;
        const st = row?.transcode_status;
        if (st === "complete" || st === "ready") {
          clearInflight();
          toast.success(`Previous upload finished — opening player…`);
          void navigate({ to: destination === "v" ? "/v/$cid" : "/v/$cid", params: { cid: inflight.cid } });
          return;
        }
        if (st === "failed") { clearInflight(); toast.error("Previous transcode job failed"); return; }
        if (startTimeRef.current === 0) startTimeRef.current = inflight.startedAt || Date.now();
        pushLog("step", `↻ resuming in-flight job for cid ${inflight.cid}${inflight.jobId ? ` (job ${inflight.jobId})` : ""}`);
        setStage("prepare", "done");
        setStage("s3-upload", "done");
        setStage("pin-ipfs", "done");
        setStage("register", "done");
        setStage("transcode", "active", inflight.jobId ? `job ${inflight.jobId}` : "polling…");
        setStage("pin-hls", "pending", "queued — will start after transcode finishes");
        setResultCid(inflight.cid);
      } catch (err) {
        pushLog("warn", `resume check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setStage(key: StageKey, state: StageState, detail?: string) {
    setStages((s) => ({ ...s, [key]: state }));
    if (detail !== undefined) setStageDetail((d) => ({ ...d, [key]: detail }));
  }

  function acceptFile(f: File) {
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    setThumbnailCid(null);
  }

  // Poll once a CID exists.
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
          const jobId = row?.transcode_job_id;
          if (jobId && !pinTriggered) {
            try {
              const job = await describeJob({ data: { jobId } });
              const awsJob = (job as { job?: { status?: string; jobPercentComplete?: number; errorMessage?: string } } | null)?.job;
              const awsStatus = awsJob?.status;
              if (awsStatus === "COMPLETE") {
                pinTriggered = true;
                pushLog("step", `AWS reports COMPLETE — kicking async HLS pin (Lambda will call back when done)…`);
                setStage("transcode", "done");
                setStage("pin-hls", "active", "pinning HLS bundle to IPFS (async)…");
                try {
                  const res = await kickPin({ data: { cid: resultCid!, jobId } });
                  pushLog("ok", `async pin started · ${res.files} files · callback ${res.callbackUrl}`);
                } catch (err) {
                  pinTriggered = false;
                  pushLog("warn", `async pin kick failed: ${err instanceof Error ? err.message : String(err)}`);
                }
              } else if (awsStatus === "ERROR" || awsStatus === "CANCELED") {
                pushLog("err", `AWS job ${jobId} ${awsStatus}${awsJob?.errorMessage ? `: ${awsJob.errorMessage}` : ""}`);
              } else if (awsStatus) {
                pushLog("info", `AWS job ${jobId} → ${awsStatus}${awsJob?.jobPercentComplete ? ` (${awsJob.jobPercentComplete}%)` : ""}`);
              }
            } catch (err) {
              pushLog("warn", `AWS describeJob failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (st === "pinning") {
          setStage("transcode", "done");
          setStage("pin-hls", "active", "pinning HLS bundle to IPFS…");
          pinTriggered = true;
          pushLog("info", `pin poll → pinning (job ${row?.transcode_job_id ?? "?"})`);
          const jobId = row?.transcode_job_id;
          const startedAt = row?.transcode_started_at ? Date.parse(row.transcode_started_at) : 0;
          const rekickKey = `${resultCid}:${jobId}`;
          if (jobId && startedAt && Date.now() - startedAt > 10 * 60 * 1000 && !rekickRef.current.has(rekickKey)) {
            rekickRef.current.add(rekickKey);
            try {
              pushLog("warn", "pinning has been running over 10 minutes — re-kicking async HLS pin…");
              const res = await kickPin({ data: { cid: resultCid!, jobId } });
              pushLog("ok", `async pin re-kicked · ${res.files} files`);
            } catch (err) {
              pushLog("warn", `async pin re-kick failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (st === "complete" || st === "ready") {
          setStage("transcode", "done");
          setStage("pin-hls", "done", row?.hls_cid ? `hls cid: ${row.hls_cid}` : undefined);
          setStage("done", "done");
          pushLog("ok", `transcode COMPLETE · hls cid: ${row?.hls_cid ?? "(missing)"}`);
          setRunning(false);
          clearInflight();
          if (pollRef.current) window.clearInterval(pollRef.current);
          if (autoNavigate && resultCid) {
            window.setTimeout(() => {
              void navigate({ to: destination === "v" ? "/v/$cid" : "/v/$cid", params: { cid: resultCid } });
            }, 1500);
          }
          return;
        } else if (st === "failed") {
          setStage("transcode", "error", row?.transcode_error ?? "MediaConvert reported failure");
          pushLog("err", `transcode FAILED: ${row?.transcode_error ?? "no error message"}`);
          setRunning(false);
          clearInflight();
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
  }, [resultCid, checkStatus, describeJob, kickPin, pushLog, navigate, autoNavigate, destination]);

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
      prepare: "pending", "s3-upload": "pending", "pin-ipfs": "pending",
      register: "pending", transcode: "pending", "pin-hls": "pending", done: "pending",
    });
    setStageDetail({});

    try {
      pushLog("step", `▶ pipeline starting · ${file.name} · ${formatBytes(file.size)} · ${file.type || "video/mp4"}`);
      pushLog("info", "checking AWS + IPFS Lambda configuration…");
      const [{ configured: awsConfigured }, ipfsCfg] = await Promise.all([checkConfig(), checkIpfs()]);
      pushLog(awsConfigured ? "ok" : "err", `aws transcode configured: ${awsConfigured}`);
      pushLog(ipfsCfg.configured ? "ok" : "err", `ipfs lambda configured: ${ipfsCfg.configured}${ipfsCfg.gateway ? ` · gateway: ${ipfsCfg.gateway}` : ""}`);
      if (!awsConfigured) throw new Error("AWS transcode pipeline not configured — set AWS_* env vars.");
      if (!ipfsCfg.configured) throw new Error("IPFS Lambda not configured — set IPFS_LAMBDA_URL + IPFS_LAMBDA_TOKEN.");
      const health = await probeIpfs();
      pushLog(health.ok ? "ok" : "warn", `ipfs lambda /health → ${health.ok ? "ok" : "fail"}`);

      setStage("prepare", "active");
      pushLog("info", "computing local CID in a Web Worker…");
      let lastHashPct = -10;
      const cids = await computeCids(file, (pct) => {
        setStage("prepare", "active", `hashing ${pct.toFixed(0)}%`);
        if (pct - lastHashPct >= 10) { lastHashPct = pct; pushLog("info", `cid hash progress: ${pct.toFixed(0)}%`); }
      });
      pushLog("ok", `cid v1: ${cids.v1}`);
      setStage("prepare", "done", `cid: ${cids.v1.slice(0, 14)}…`);

      // First check our DB — is there already a video row for this CID? That
      // catches both "already pinned + transcoded" AND "stuck mid-transcode"
      // cases so the user doesn't waste time re-uploading multi-GB bytes.
      for (const probeCid of [cids.v1, cids.v0]) {
        const row = await checkStatus({ data: { cid: probeCid } }).catch(() => null);
        if (!row) continue;
        const st = row.transcode_status;
        pushLog("warn", `found existing video row for cid ${probeCid} · status: ${st ?? "unknown"}`);
        if (st === "complete" || st === "ready") {
          setDuplicate({ cid: probeCid, ownerWallet: "", title: "", createdAt: "", txHash: null });
          setStage("s3-upload", "done", "skipped — already exists");
          setStage("pin-ipfs", "done", "skipped — already exists");
          setStage("register", "done", "skipped — already exists");
          setStage("transcode", "done", "skipped — already exists");
          setStage("pin-hls", "done", "skipped — already exists");
          toast.info("This exact file is already on the site — opening the existing video.");
          setTimeout(() => {
            void navigate({ to: destination === "v" ? "/v/$cid" : "/v/$cid", params: { cid: probeCid } });
          }, 1500);
          return;
        }
        if (st === "processing" || st === "pending" || st == null) {
          // Row exists but transcode hasn't finished — resume by polling.
          pushLog("info", `resuming existing job — skipping upload/pin, will poll transcode status`);
          setStage("s3-upload", "done", "skipped — already uploaded");
          setStage("pin-ipfs", "done", "skipped — already pinned");
          setStage("register", "done", "skipped — already registered");
          setStage("transcode", "active", row.transcode_job_id ? `job ${row.transcode_job_id}` : "polling…");
          setStage("pin-hls", "pending", "queued — will start after transcode finishes");
          setResultCid(probeCid);
          saveInflight({ cid: probeCid, jobId: row.transcode_job_id ?? undefined, startedAt: Date.now() });
          toast.info("This file is already uploaded — resuming its transcode job.");
          return;
        }
        if (st === "failed") {
          pushLog("warn", `previous transcode failed (${row.transcode_error ?? "unknown"}) — will retry the pipeline`);
          // Fall through to Pinata check + normal upload path
        }
      }

      const hit = await lookupCid({ data: { cidV1: cids.v1, cidV0: cids.v0 } });
      if (hit) {
        pushLog("ok", `already pinned on IPFS as ${hit.cid} — skipping S3 upload + pin, will pull from IPFS → S3 server-side`);
        const canonicalCid = hit.cid;
        setStage("s3-upload", "done", "skipped — pulling from IPFS server-side");
        setStage("pin-ipfs", "done", "skipped — already pinned");

        setStage("register", "active");
        const submitWallet = address ?? getWallet();
        const result = await register({
          data: {
            wallet: submitWallet ?? undefined,
            cid: canonicalCid,
            title, description,
            sizeBytes: file.size,
            mimeType: file.type || "video/mp4",
            months: 1,
            thumbnailCid: thumbnailCid ?? undefined,
            nsfw,
            draftId: draftRef.current?.id,
            draftToken: draftRef.current?.token,
          },
        });
        pushLog("ok", `registered · ${result.chainStatus}`);
        setStage("register", "done",
          result.chainStatus === "stamp_failed"
            ? "Saved · chain stamp queued for retry"
            : "Row saved · TXC stamp broadcast");
        if (!submitWallet) recordAnonUpload(result.cid, title);
        qc.invalidateQueries({ queryKey: ["recent-videos"] });
        setResultCid(result.cid);

        setStage("transcode", "active", "fetching bytes from IPFS → S3 server-side…");
        try {
          const kickoff = await kickoffHlsFromCid({ data: { cid: canonicalCid } });
          if (kickoff.ok) {
            pushLog("ok", `MediaConvert job queued via IPFS pull · ${kickoff.jobId ?? ""}`);
            setStage("transcode", "active", kickoff.jobId ? `job ${kickoff.jobId}` : "queued");
            setStage("pin-hls", "pending", "queued — will start after transcode finishes");
            saveInflight({ cid: result.cid, jobId: kickoff.jobId ?? undefined, startedAt: Date.now() });
          } else {
            throw new Error(kickoff.error ?? "kickoffHlsFromCid failed");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Could not start transcode";
          pushLog("err", `kickoffHlsFromCid failed: ${msg}`);
          setStage("transcode", "error", msg);
        }
        return;
      } else {
        pushLog("ok", "no existing video found — fresh upload");
      }

      setStage("s3-upload", "active");
      const ct = file.type || "video/mp4";
      // Preflight: if a prior attempt already landed the bytes in S3,
      // skip the re-upload entirely and jump straight to pinning. This
      // is the common case when a multi-GB pin was interrupted and the
      // user retries — we don't want them uploading 3 GB again.
      let bucket: string;
      let key: string;
      const pre = await preflightS3({ data: { cid: cids.v1 } }).catch(() => null);
      if (pre && pre.exists && pre.size === file.size) {
        bucket = pre.bucket;
        key = pre.key;
        pushLog("ok", `S3 already has this file · ${bucket}/${key} · ${formatBytes(pre.size)} — skipping re-upload`);
        setS3Progress(100);
        setStage("s3-upload", "done", "resumed from S3");
      } else {
        if (pre && pre.exists) {
          pushLog("warn", `S3 has a stale object at inputs/${cids.v1} (${formatBytes(pre.size)}) but size differs — re-uploading`);
        }
        const s3 = await getS3Url({ data: { cid: cids.v1, contentType: ct } });
        bucket = s3.bucket;
        key = s3.key;
        pushLog("ok", `presigned url received · ${bucket}/${key}`);
        pushLog("info", `uploading ${formatBytes(file.size)}…`);
        const tUp = Date.now();
        await putWithProgress(s3.url, file, ct, (p) => setS3Progress(p));
        const upMs = Date.now() - tUp;
        pushLog("ok", `S3 PUT complete in ${upMs}ms`);
        setStage("s3-upload", "done");
      }

      setStage("pin-ipfs", "active");
      const pinned = await pinFromS3({ data: { bucket, keys: [key] } });
      pushLog("ok", `pinned · wrap: ${pinned.wrapCid.slice(0, 14)}… · inner: ${pinned.fileCid?.slice(0, 14) ?? "?"}…`);
      const canonicalCid = pinned.fileCid ?? cids.v1;
      setStage("pin-ipfs", "done", `cid: ${canonicalCid.slice(0, 14)}…`);

      setStage("register", "active");
      // Read wallet synchronously at submit time — the `address` from
      // useWallet() hydrates from localStorage inside a useEffect and can
      // be stale/null on the first render, which was causing logged-in
      // users to have their uploads silently registered as anonymous.
      const submitWallet = address ?? getWallet();
      const result = await register({
        data: {
          wallet: submitWallet ?? undefined,
          cid: canonicalCid,
          title, description,
          sizeBytes: file.size,
          mimeType: file.type || "video/mp4",
          months: 1,
          thumbnailCid: thumbnailCid ?? undefined,
          nsfw,
          draftId: draftRef.current?.id,
          draftToken: draftRef.current?.token,
        },
      });
      pushLog("ok", `registered · ${result.chainStatus}`);
      setStage("register", "done",
        result.chainStatus === "stamp_failed"
          ? "Saved · chain stamp queued for retry"
          : "Row saved · TXC stamp broadcast");
      if (!submitWallet) recordAnonUpload(result.cid, title);
      qc.invalidateQueries({ queryKey: ["recent-videos"] });
      setResultCid(result.cid);

      setStage("transcode", "active", "queueing MediaConvert job…");
      try {
        const { jobId } = await startTx({ data: { cid: canonicalCid } });
        pushLog("ok", `MediaConvert job queued · ${jobId}`);
        setStage("transcode", "active", `job ${jobId}`);
        setStage("pin-hls", "pending", "queued — will start after transcode finishes");
        saveInflight({ cid: result.cid, jobId, startedAt: Date.now() });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not start transcode";
        pushLog("err", `startTranscode failed: ${msg}`);
        setStage("transcode", "error", msg);
      }
    } catch (err) {
      console.error(err);
      const dup = parseDuplicateCidError(err);
      if (dup) {
        pushLog("err", `duplicate CID — already on stream as "${dup.title}"`);
        setDuplicate(dup);
        toast.error(`Already on stream: "${dup.title}" — redirecting…`);
        setRunning(false);
        setTimeout(() => {
          void navigate({ to: destination === "v" ? "/v/$cid" : "/v/$cid", params: { cid: dup.cid } });
        }, 1500);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("err", msg);
        setError(msg);
        toast.error(msg);
        setRunning(false);
      }
    }
  }

  return (
    <div className="space-y-6">
      {duplicate && (
        <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs text-destructive mb-1">[ ALREADY ON STREAM ]</div>
              <div className="font-bold mb-2">"{duplicate.title}"</div>
              <Link to="/v/$cid" params={{ cid: duplicate.cid }}
                className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                → view the original
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
              isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary"
            }`}
            onDragOver={(e) => { e.preventDefault(); if (!isDragging) setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
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
              onChange={(e) => { const f = e.target.files?.[0]; if (f) acceptFile(f); }}
            />
            {file ? (
              <div className="flex items-center gap-4">
                <FileVideo className="h-8 w-8 text-primary" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm break-all">{file.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {formatBytes(file.size)} · {file.type || "video/mp4"}
                  </div>
                </div>
                {tooBig && <span className="font-mono text-xs text-destructive">OVER LIMIT</span>}
              </div>
            ) : (
              <div className="text-center">
                <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                <div className="font-mono text-sm">
                  {isDragging ? "drop to upload" : "drag & drop or click to choose a video"}
                </div>
                <div className="font-mono text-xs text-muted-foreground mt-1">
                  mp4 / webm / mov · max {formatBytes(MAX_S3_UPLOAD_BYTES)}
                </div>
              </div>
            )}
          </label>
        </div>

        <div className="space-y-2">
          <Label htmlFor="title" className="font-mono text-xs">TITLE</Label>
          <Input id="title" value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => pushDraft({ title })}
            required maxLength={200} className="font-mono" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description" className="font-mono text-xs">DESCRIPTION (optional)</Label>
          <Textarea id="description" value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => pushDraft({ description })}
            maxLength={2000} rows={3} />
        </div>

        {file && !tooBig && (
          <ThumbnailPicker
            file={file}
            onChange={(cid) => {
              setThumbnailCid(cid);
              if (cid) pushDraft({ thumbnailCid: cid });
            }}
          />
        )}

        <label className="flex items-start gap-3 border border-border bg-card rounded-sm p-4 cursor-pointer">
          <Checkbox checked={nsfw}
            onCheckedChange={(v) => {
              const next = v === true;
              setNsfw(next);
              pushDraft({ nsfw: next });
            }}
            className="mt-0.5" />
          <div className="flex-1">
            <div className="font-mono text-xs">[ NSFW / ADULT CONTENT ]</div>
            <p className="text-xs text-muted-foreground mt-1">Hidden from homepage and public listings.</p>
          </div>
        </label>

        <Button type="submit" disabled={!file || !title || tooBig || running}
          className="w-full font-mono" size="lg">
          {running ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running pipeline…</>
          ) : (
            <>Upload & transcode <ArrowRight className="ml-2 h-4 w-4" /></>
          )}
        </Button>
      </form>

      {(running || resultCid || error) && (
        <>
          <StageTracker stages={stages} detail={stageDetail} s3Progress={s3Progress} />
          <Collapsible open={logOpen} onOpenChange={setLogOpen}>
            <CollapsibleTrigger className="w-full border border-border rounded-sm px-4 py-3 bg-card flex items-center justify-between hover:border-primary/60 transition-colors">
              <span className="flex items-center gap-2 font-mono text-xs text-primary">
                <Terminal className="h-3 w-3" />
                [ PIPELINE LOG · {log.length} LINES ]
              </span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${logOpen ? "rotate-180" : ""}`} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <LogPanel log={log} boxRef={logBoxRef} />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}

      {resultCid && (
        <div className="border border-primary/40 bg-primary/5 rounded-sm p-5 space-y-3">
          <div className="flex items-center gap-2 font-mono text-xs text-primary">
            <CheckCircle2 className="h-4 w-4" />
            [ VIDEO REGISTERED · CID {resultCid.slice(0, 16)}… ]
          </div>
          <p className="text-sm text-muted-foreground">
            Your video is live now. HLS playback will appear as soon as
            MediaConvert finishes and pins the bundle to IPFS. You'll be
            redirected when it's ready.
          </p>
          <label className="flex items-center gap-2 font-mono text-xs">
            <Checkbox checked={autoNavigate} onCheckedChange={(v) => setAutoNavigate(v === true)} />
            auto-navigate when HLS is ready
          </label>
          <div className="flex gap-2 flex-wrap">
            <Link to="/v/$cid" params={{ cid: resultCid }}>
              <Button size="sm" className="font-mono">Watch on v2 <ArrowRight className="ml-2 h-3 w-3" /></Button>
            </Link>
            <Link to="/v/$cid" params={{ cid: resultCid }}>
              <Button size="sm" variant="outline" className="font-mono">Watch on v1</Button>
            </Link>
          </div>
        </div>
      )}

      {error && (
        <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-4 font-mono text-xs text-destructive whitespace-pre-wrap break-all">
          {error}
        </div>
      )}
    </div>
  );
}

function StageTracker({
  stages, detail, s3Progress,
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
                  <span className={"font-mono text-sm " + (
                    state === "done" ? "text-primary"
                    : state === "active" ? "text-foreground"
                    : state === "error" ? "text-destructive"
                    : state === "skipped" ? "text-muted-foreground line-through"
                    : "text-muted-foreground"
                  )}>{s.label}</span>
                  <StageBadge state={state} />
                </div>
                <div className="font-mono text-[11px] text-muted-foreground break-all">
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
  log, boxRef,
}: {
  log: LogLine[];
  boxRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const copyAll = () => {
    const text = log.map((l) => `[+${(l.t / 1000).toFixed(2)}s] ${l.level.toUpperCase().padEnd(4)} ${l.msg}`).join("\n");
    void navigator.clipboard?.writeText(text);
    toast.success("Log copied");
  };
  return (
    <div className="border border-t-0 border-border rounded-b-sm overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-card flex items-center justify-end">
        <button type="button" onClick={copyAll} disabled={log.length === 0}
          className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-primary disabled:opacity-40 flex items-center gap-1">
          <Copy className="h-3 w-3" /> copy
        </button>
      </div>
      <div ref={boxRef} className="bg-black text-green-300 font-mono text-[11px] leading-relaxed p-4 h-72 overflow-auto">
        {log.length === 0 ? (
          <div className="text-muted-foreground">// no log entries yet</div>
        ) : log.map((l, i) => {
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
        })}
      </div>
    </div>
  );
}

function StageIcon({ state, Icon }: { state: StageState; Icon: React.ComponentType<{ className?: string }> }) {
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
    error: { text: "error", cls: "text-destructive border-destructive/50" },
  };
  const { text, cls } = map[state];
  return <span className={`font-mono text-[10px] uppercase tracking-wider border rounded-sm px-1.5 py-0.5 ${cls}`}>{text}</span>;
}