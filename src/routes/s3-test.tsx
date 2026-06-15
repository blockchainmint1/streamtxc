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
} from "@/lib/transcode.functions";
import { VideoPlayer } from "@/components/VideoPlayer";

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
      const { url, bucket, key } = await getUrl({ data: { cid, contentType: ct } });
      push(`presigned: PUT s3://${bucket}/${key}`);
      push(`url host: ${new URL(url).host}`);

      const t0 = performance.now();
      setUploadPct(0);
      setUploadStats({ loaded: 0, total: file.size, bps: 0 });
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
          xhr.onload = () =>
            resolve({ status: xhr.status, body: xhr.responseText || "" });
          xhr.onerror = () => reject(new Error("network error during PUT"));
          xhr.onabort = () => reject(new Error("upload aborted"));
          xhr.send(file);
        },
      );
      const ms = Math.round(performance.now() - t0);
      setUploadPct(100);
      push(`PUT → ${status} in ${ms}ms`);
      if (body) push(`response body: ${body.slice(0, 1500)}`);
      if (status >= 200 && status < 300) {
        push(`✅ Object written to ${bucket}/${key}`);
        setLastKey(key);
      } else {
        push(`❌ Upload failed`);
      }
    } catch (err) {
      push(`💥 ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
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