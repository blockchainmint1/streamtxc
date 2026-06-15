import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  getTranscodeUploadUrl,
  isTranscodeConfigured,
  startTranscodeTest,
  getMediaConvertJob,
} from "@/lib/transcode.functions";

export const Route = createFileRoute("/s3-test")({
  head: () => ({ meta: [{ title: "S3 PUT test" }] }),
  component: S3Test,
});

function S3Test() {
  const getUrl = useServerFn(getTranscodeUploadUrl);
  const checkCfg = useServerFn(isTranscodeConfigured);
  const startJob = useServerFn(startTranscodeTest);
  const describeJob = useServerFn(getMediaConvertJob);
  const [file, setFile] = useState<File | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

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
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": ct },
        body: file,
      });
      const ms = Math.round(performance.now() - t0);
      const body = await res.text().catch(() => "");
      push(`PUT → ${res.status} in ${ms}ms`);
      if (body) push(`response body: ${body.slice(0, 1500)}`);
      if (res.ok) {
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
      </div>

      <pre className="mt-6 bg-muted text-foreground p-4 rounded whitespace-pre-wrap break-all min-h-[200px]">
        {log.join("\n") || "(no output yet)"}
      </pre>
    </main>
  );
}