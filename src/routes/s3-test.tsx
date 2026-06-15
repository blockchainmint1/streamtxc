import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  getTranscodeUploadUrl,
  isTranscodeConfigured,
  startTranscodeTest,
  getMediaConvertJob,
  listTranscodeOutputs,
  simulateMediaConvertWebhook,
  getPinataGateway,
  startMultipartUpload,
  signMultipartPart,
  finishMultipartUpload,
  cancelMultipartUpload,
} from "@/lib/transcode.functions";
import { VideoPlayer } from "@/components/VideoPlayer";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n.toFixed(0)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const Route = createFileRoute("/s3-test")({
  head: () => ({ meta: [{ title: "S3 PUT test" }] }),
  component: S3Test,
});

function S3Test() {
  const getUrl = useServerFn(getTranscodeUploadUrl);
  const checkCfg = useServerFn(isTranscodeConfigured);
  const startJob = useServerFn(startTranscodeTest);
  const describeJob = useServerFn(getMediaConvertJob);
  const listOutputs = useServerFn(listTranscodeOutputs);
  const simulateHook = useServerFn(simulateMediaConvertWebhook);
  const getGateway = useServerFn(getPinataGateway);
  const mpStart = useServerFn(startMultipartUpload);
  const mpSign = useServerFn(signMultipartPart);
  const mpFinish = useServerFn(finishMultipartUpload);
  const mpCancel = useServerFn(cancelMultipartUpload);
  const [file, setFile] = useState<File | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pinnedCid, setPinnedCid] = useState<string | null>(null);
  const [gateway, setGateway] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string>("");
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadStats, setUploadStats] = useState<{
    loaded: number;
    total: number;
    bps: number;
  } | null>(null);

  useEffect(() => {
    getGateway().then((g) => setGateway(g.gateway)).catch(() => {});
  }, [getGateway]);

  function push(line: string) {
    setLog((l) => [...l, `[${new Date().toISOString().slice(11, 19)}] ${line}`]);
  }

  async function run() {
    if (!file) return;
    setBusy(true);
    setLog([]);
    try {
      push(`file: ${file.name} (${file.size} bytes, type="${file.type || "(empty)"}")`);

      const cfg = await checkCfg();
      push(`isTranscodeConfigured: ${cfg.configured}`);
      if (!cfg.configured) throw new Error("AWS env vars missing on server");

      const cid = `s3-test-${Date.now()}`;
      const ct = file.type || "application/octet-stream";

      // Threshold: anything ≥ 50 MB goes multipart. Smaller → simple PUT.
      const MULTIPART_THRESHOLD = 50 * 1024 * 1024;
      if (file.size >= MULTIPART_THRESHOLD) {
        const key = await uploadMultipart(file, cid, ct);
        if (key) setLastKey(key);
      } else {
        const key = await uploadSimple(file, cid, ct);
        if (key) setLastKey(key);
      }
    } catch (err) {
      push(`💥 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function uploadSimple(f: File, cid: string, ct: string): Promise<string | null> {
    const { url, bucket, key } = await getUrl({ data: { cid, contentType: ct } });
    push(`presigned: PUT s3://${bucket}/${key}`);
    push(`url host: ${new URL(url).host}`);
    const t0 = performance.now();
    setUploadPct(0);
    setUploadStats({ loaded: 0, total: f.size, bps: 0 });
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("content-type", ct);
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const elapsed = (performance.now() - t0) / 1000;
          const bps = elapsed > 0 ? e.loaded / elapsed : 0;
          setUploadPct(Math.round((e.loaded / e.total) * 100));
          setUploadStats({ loaded: e.loaded, total: e.total, bps });
        };
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText || "" });
        xhr.onerror = () => reject(new Error("network error during PUT"));
        xhr.onabort = () => reject(new Error("upload aborted"));
        xhr.send(f);
      },
    );
    const ms = Math.round(performance.now() - t0);
    setUploadPct(100);
    push(`PUT → ${status} in ${ms}ms`);
    if (body) push(`response body: ${body.slice(0, 1500)}`);
    if (status >= 200 && status < 300) {
      push(`✅ Object written to ${bucket}/${key}`);
      return key;
    }
    push(`❌ Upload failed`);
    return null;
  }

  async function uploadMultipart(f: File, cid: string, ct: string): Promise<string | null> {
    // Tunables: 10 MB parts × 4 in parallel ≈ 40 MB in-flight.
    // S3 minimum part size is 5 MB (last part can be smaller).
    const PART_SIZE = 10 * 1024 * 1024;
    const CONCURRENCY = 4;
    const totalParts = Math.ceil(f.size / PART_SIZE);
    push(`multipart upload: ${totalParts} parts × ${fmtBytes(PART_SIZE)} (concurrency=${CONCURRENCY})`);

    const init = await mpStart({ data: { cid, contentType: ct } });
    push(`init multipart: s3://${init.bucket}/${init.key}`);
    push(`uploadId: ${init.uploadId.slice(0, 40)}…`);

    const t0 = performance.now();
    setUploadPct(0);
    setUploadStats({ loaded: 0, total: f.size, bps: 0 });

    // Per-part progress tracker — sum across all parts in flight.
    const partLoaded = new Array<number>(totalParts).fill(0);
    const updateProgress = () => {
      const loaded = partLoaded.reduce((a, b) => a + b, 0);
      const elapsed = (performance.now() - t0) / 1000;
      const bps = elapsed > 0 ? loaded / elapsed : 0;
      setUploadPct(Math.min(99, Math.round((loaded / f.size) * 100)));
      setUploadStats({ loaded, total: f.size, bps });
    };

    const parts: { partNumber: number; etag: string }[] = [];

    async function uploadPart(idx: number): Promise<void> {
      const partNumber = idx + 1;
      const start = idx * PART_SIZE;
      const end = Math.min(start + PART_SIZE, f.size);
      const blob = f.slice(start, end);
      // Retry up to 3× per part on transient failure.
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { url } = await mpSign({
            data: { key: init.key, uploadId: init.uploadId, partNumber },
          });
          const etag = await new Promise<string>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", url);
            xhr.upload.onprogress = (e) => {
              if (!e.lengthComputable) return;
              partLoaded[idx] = e.loaded;
              updateProgress();
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                const tag = xhr.getResponseHeader("ETag");
                if (!tag) {
                  reject(
                    new Error(
                      "Missing ETag header on part response — bucket CORS must expose ETag",
                    ),
                  );
                  return;
                }
                partLoaded[idx] = blob.size;
                updateProgress();
                resolve(tag);
              } else {
                reject(new Error(`part ${partNumber} → HTTP ${xhr.status}`));
              }
            };
            xhr.onerror = () => reject(new Error(`part ${partNumber}: network error`));
            xhr.onabort = () => reject(new Error(`part ${partNumber}: aborted`));
            xhr.send(blob);
          });
          parts.push({ partNumber, etag });
          return;
        } catch (err) {
          lastErr = err;
          partLoaded[idx] = 0;
          updateProgress();
          push(`  ⚠ part ${partNumber} attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`part ${partNumber} failed`);
    }

    try {
      // Worker pool: pull next part index until exhausted.
      let nextIdx = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, totalParts) }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= totalParts) return;
          await uploadPart(idx);
        }
      });
      await Promise.all(workers);

      push(`all ${totalParts} parts uploaded — completing…`);
      await mpFinish({
        data: { key: init.key, uploadId: init.uploadId, parts },
      });
      const ms = Math.round(performance.now() - t0);
      setUploadPct(100);
      push(`✅ multipart complete in ${ms}ms → s3://${init.bucket}/${init.key}`);
      return init.key;
    } catch (err) {
      push(`💥 multipart failed: ${err instanceof Error ? err.message : String(err)}`);
      push(`aborting upload to free S3 storage…`);
      await mpCancel({ data: { key: init.key, uploadId: init.uploadId } }).catch(() => {});
      push(`aborted.`);
      return null;
    }
  }

  async function runTranscode() {
    if (!lastKey) return;
    setBusy(true);
    try {
      push(`startTranscode key=${lastKey}`);
      const r = await startJob({ data: { key: lastKey } });
      push(`✅ jobId=${r.jobId}`);
      push(`input:  ${r.inputUri}`);
      push(`output: ${r.outputPrefix}`);
      setJobId(r.jobId);
    } catch (err) {
      push(`💥 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function pollJob() {
    if (!jobId) return;
    setBusy(true);
    try {
      const r = await describeJob({ data: { jobId } });
      const j = r.job;
      push(
        `job ${jobId}: status=${j?.status ?? "?"} pct=${j?.jobPercentComplete ?? 0}` +
          (j?.errorMessage ? ` err=${j.errorMessage}` : ""),
      );
    } catch (err) {
      push(`💥 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function cidFromKey(): string | null {
    if (!lastKey) return null;
    return lastKey.split("/").pop() ?? null;
  }

  async function runListOutputs() {
    const cid = cidFromKey();
    if (!cid) return;
    setBusy(true);
    try {
      const r = await listOutputs({ data: { cid } });
      push(`s3 ls s3://${r.bucket}/${r.prefix} → ${r.keys.length} keys`);
      for (const k of r.keys) push(`  ${k}`);
    } catch (err) {
      push(`💥 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runSimulateWebhook() {
    const cid = cidFromKey();
    if (!cid || !jobId) return;
    setBusy(true);
    try {
      push(`POST /api/public/hooks/mediaconvert?dryRun=1`);
      const r = await simulateHook({ data: { cid, jobId, dryRun: true } });
      push(`webhook → ${r.status}`);
      push(r.body.slice(0, 2000));
    } catch (err) {
      push(`💥 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runFullWebhook() {
    const cid = cidFromKey();
    if (!cid || !jobId) return;
    if (!confirm("This will fetch all HLS outputs from S3 and pin them to IPFS via Pinata. Continue?")) return;
    setBusy(true);
    try {
      push(`POST /api/public/hooks/mediaconvert (REAL — pins to IPFS)`);
      const t0 = performance.now();
      const r = await simulateHook({ data: { cid, jobId, dryRun: false } });
      const ms = Math.round(performance.now() - t0);
      push(`webhook → ${r.status} in ${ms}ms`);
      push(r.body.slice(0, 2000));
      try {
        const parsed = JSON.parse(r.body) as {
          hlsCid?: string;
          originalCid?: string;
          metadataCid?: string;
        };
        const hls = parsed.hlsCid;
        if (hls) {
          setPinnedCid(hls);
          if (gateway) {
            const url = `https://${gateway}/ipfs/${hls}/${cid}.m3u8`;
            setPlayUrl(url);
            push(`▶ player src: ${url}`);
          }
        }
        if (parsed.originalCid) push(`📁 original cid: ${parsed.originalCid}`);
        if (parsed.metadataCid) push(`🪪 metadata cid: ${parsed.metadataCid}`);
      } catch { /* non-JSON response, ignore */ }
    } catch (err) {
      push(`💥 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12 font-mono text-sm">
      <h1 className="text-2xl font-bold mb-2">S3 PUT test</h1>
      <p className="text-muted-foreground mb-6">
        Pick a file → presign via server fn → PUT to S3. Shows every step.
      </p>

      <input
        type="file"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={busy}
        className="block mb-4"
      />
      {uploadPct !== null && (
        <div className="mb-4">
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>
              {uploadPct < 100 ? "Uploading…" : "Upload complete"} {uploadPct}%
            </span>
            {uploadStats && (
              <span>
                {fmtBytes(uploadStats.loaded)} / {fmtBytes(uploadStats.total)}
                {uploadStats.bps > 0 && uploadPct < 100
                  ? ` · ${fmtBytes(uploadStats.bps)}/s`
                  : ""}
              </span>
            )}
          </div>
          <div className="h-2 bg-muted rounded overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-150"
              style={{ width: `${uploadPct}%` }}
            />
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={run}
          disabled={!file || busy}
          className="bg-primary text-primary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          {busy ? "Working…" : "1. Upload to S3"}
        </button>
        <button
          onClick={runTranscode}
          disabled={!lastKey || busy}
          className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          2. Start MediaConvert
        </button>
        <button
          onClick={pollJob}
          disabled={!jobId || busy}
          className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          3. Poll job status
        </button>
        <button
          onClick={runListOutputs}
          disabled={!lastKey || busy}
          className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          4. List S3 outputs
        </button>
        <button
          onClick={runSimulateWebhook}
          disabled={!jobId || busy}
          className="bg-secondary text-secondary-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          5. Simulate webhook (dry-run)
        </button>
        <button
          onClick={runFullWebhook}
          disabled={!jobId || busy}
          className="bg-destructive text-destructive-foreground px-4 py-2 rounded disabled:opacity-50"
        >
          6. Full webhook (pin to IPFS)
        </button>
      </div>

      <pre className="mt-6 bg-muted text-foreground p-4 rounded whitespace-pre-wrap break-all min-h-[200px]">
        {log.join("\n") || "(no output yet)"}
      </pre>

      <section className="mt-10">
        <h2 className="text-xl font-bold mb-2">HLS player</h2>
        <p className="text-muted-foreground mb-3">
          After button 6 pins to IPFS, the master playlist URL auto-fills below.
          You can also paste any .m3u8 URL (S3, IPFS, anywhere CORS allows).
        </p>
        <div className="flex gap-2 mb-4">
          <input
            type="url"
            value={playUrl}
            onChange={(e) => setPlayUrl(e.target.value)}
            placeholder="https://…/master.m3u8"
            className="flex-1 bg-muted text-foreground px-3 py-2 rounded text-xs"
          />
          <button
            onClick={() => setPlayUrl("")}
            disabled={!playUrl}
            className="bg-muted text-foreground px-3 py-2 rounded disabled:opacity-50"
          >
            Clear
          </button>
        </div>
        {pinnedCid && gateway && (
          <p className="text-xs text-muted-foreground mb-3 break-all">
            pinned cid: <code>{pinnedCid}</code> · gateway: <code>{gateway}</code>
          </p>
        )}
        <div className="aspect-video bg-black rounded overflow-hidden">
          {playUrl ? (
            <VideoPlayer key={playUrl} src={playUrl} autoPlay muted />
          ) : (
            <div className="w-full h-full grid place-items-center text-muted-foreground text-xs">
              (no source yet — run steps 1–6 or paste an .m3u8 URL above)
            </div>
          )}
        </div>
      </section>
    </main>
  );
}