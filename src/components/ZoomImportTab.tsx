// "Zoom URL" tab on /upload-aws.
//
// Flow:
//   1. User pastes a Zoom share URL (+ optional passcode).
//   2. resolveImportUrl({ url, passcode }) → server fetches the share page,
//      pulls the signed mp4 URL out of the SSR HTML, returns a token plus
//      the recording's suggested title.
//   3. User confirms title/description, clicks Import. We POST the token
//      to /api/public/import-stream, which streams the mp4 from Zoom's
//      signed CloudFront URL into Pinata, returning a CID.
//   4. Register the CID with source='zoom'. addByCid kicks off the
//      standard ownership/metadata stamp.
//   5. Kick off the HLS transcode (fetches the CID back from IPFS into S3,
//      then MediaConvert). The transcode webhook will pin the HLS bundle
//      AND transcribe the audio output via Lovable AI, attaching the
//      transcript to the videos row.
//   6. Navigate to /v/<cid>.

import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Loader2,
  Sparkles,
  Video,
  AlertTriangle,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  resolveImportUrl,
  getImportStatus,
} from "@/lib/imports.functions";
import { addByCid } from "@/lib/videos.functions";
import { kickoffHlsFromCid } from "@/lib/transcode.functions";
import { formatBytes } from "@/lib/fees";
import { recordAnonUpload } from "@/lib/anon-uploads";
import { parseDuplicateCidError } from "@/lib/duplicate-cid";

interface Props {
  ownerWallet: string | null;
  onDuplicate: (info: ReturnType<typeof parseDuplicateCidError>) => void;
}

type Stage =
  | "idle"
  | "resolving"
  | "ready"
  | "streaming"
  | "registering"
  | "done";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function ZoomImportTab({ ownerWallet, onDuplicate }: Props) {
  const resolve = useServerFn(resolveImportUrl);
  const status = useServerFn(getImportStatus);
  const addCid = useServerFn(addByCid);
  const kickHls = useServerFn(kickoffHlsFromCid);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [url, setUrl] = useState("");
  const [passcode, setPasscode] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [resolved, setResolved] = useState<{
    filename: string;
    sizeBytes: number | null;
    token: string;
    suggestedTitle: string | null;
  } | null>(null);
  const [bytesUploaded, setBytesUploaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  async function handleResolve() {
    const target = url.trim();
    if (!target) return;
    setError(null);
    setStage("resolving");
    setResolved(null);
    try {
      const r = await resolve({
        data: {
          url: target,
          passcode: passcode.trim() || undefined,
        },
      });
      if (r.source !== "zoom") {
        throw new Error(
          "That URL didn't resolve as a Zoom share — paste a https://zoom.us/rec/share/… link.",
        );
      }
      setResolved({
        filename: r.filename,
        sizeBytes: r.sizeBytes,
        token: r.token,
        suggestedTitle: r.suggestedTitle ?? null,
      });
      if (!title) {
        setTitle((r.suggestedTitle ?? r.filename).replace(/\.[^.]+$/, ""));
      }
      setStage("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resolve link";
      setError(msg);
      setStage("idle");
    }
  }

  async function pollUntilDone(id: string): Promise<string> {
    while (true) {
      let row;
      try {
        row = await status({ data: { id } });
      } catch {
        await sleep(1500);
        continue;
      }
      if (typeof row.bytes_uploaded === "number") {
        setBytesUploaded(Number(row.bytes_uploaded));
      }
      if (row.status === "done" && row.cid) return row.cid;
      if (row.status === "failed") {
        throw new Error(row.error_message || "Import failed");
      }
      await sleep(1000);
    }
  }

  async function handleImport() {
    if (!resolved || !title) return;
    setError(null);
    setStage("streaming");
    setBytesUploaded(0);

    try {
      const res = await fetch("/api/public/import-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resolved.token }),
      });
      if (!res.ok) {
        let msg = `Failed to start import (${res.status})`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const { id } = (await res.json()) as { id: string };

      const finalCid = await pollUntilDone(id);

      setStage("registering");
      const result = await addCid({
        data: {
          wallet: ownerWallet ?? undefined,
          cid: finalCid,
          title,
          description,
          months: 1,
          source: "zoom",
        },
      });

      // Kick off HLS + audio transcode (which will trigger transcription
      // for zoom-source videos on completion). Best-effort.
      try {
        await kickHls({ data: { cid: result.cid } });
      } catch (err) {
        console.warn("kickoffHlsFromCid failed:", err);
      }

      if (result.chainStatus === "stamp_failed") {
        toast.error("Pinned to IPFS, but TXC stamp failed");
      } else {
        toast.success("Imported from Zoom → IPFS · transcribing audio…");
      }
      if (!ownerWallet) recordAnonUpload(result.cid, title);
      qc.invalidateQueries({ queryKey: ["recent-videos"] });
      setStage("done");
      navigate({ to: "/v/$cid", params: { cid: result.cid } });
    } catch (err) {
      const dup = parseDuplicateCidError(err);
      if (dup) {
        onDuplicate(dup);
        toast.error("This recording is already on stream.");
      } else {
        const msg = err instanceof Error ? err.message : "Import failed";
        setError(msg);
        toast.error(msg);
      }
      setStage("ready");
    }
  }

  const pct = (() => {
    if (!resolved?.sizeBytes || !bytesUploaded) return 0;
    return Math.min(100, (bytesUploaded / resolved.sizeBytes) * 100);
  })();

  const locked = stage === "resolving" || stage === "streaming" || stage === "registering";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="zoom-url" className="font-mono text-xs">
          ZOOM SHARE URL
        </Label>
        <Input
          id="zoom-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://zoom.us/rec/share/…"
          disabled={locked}
          className="font-mono"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="zoom-passcode" className="font-mono text-xs">
          <Lock className="inline h-3 w-3 mr-1" />
          PASSCODE (optional)
        </Label>
        <Input
          id="zoom-passcode"
          type="text"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="leave blank if the share has no passcode"
          disabled={locked}
          className="font-mono"
        />
        <p className="font-mono text-[11px] text-muted-foreground">
          We fetch the share page server-side, extract the signed mp4 URL,
          stream it to IPFS, then transcribe the audio with AI. Login-walled
          shares aren't supported — download the file manually and use the
          regular Upload tab.
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={handleResolve}
        disabled={!url.trim() || locked}
        className="font-mono w-full"
      >
        {stage === "resolving" ? (
          <>
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
            Resolving Zoom share…
          </>
        ) : (
          <>
            <Sparkles className="mr-2 h-3 w-3" />
            Resolve
          </>
        )}
      </Button>

      {error && (
        <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs text-destructive mb-1">
                [ ZOOM IMPORT FAILED ]
              </div>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        </div>
      )}

      {resolved && (
        <>
          <div className="border border-primary/40 bg-primary/5 rounded-sm p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="font-mono text-xs text-primary uppercase">
                  [ Zoom recording resolved ]
                </div>
                {resolved.suggestedTitle && (
                  <div className="font-mono text-sm truncate">
                    {resolved.suggestedTitle}
                  </div>
                )}
                <div className="font-mono text-xs text-muted-foreground truncate">
                  {resolved.filename}
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {resolved.sizeBytes
                    ? formatBytes(resolved.sizeBytes)
                    : "Size: streaming (Zoom doesn't pre-declare it)"}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="zoom-title" className="font-mono text-xs">
              TITLE
            </Label>
            <Input
              id="zoom-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              className="font-mono"
              disabled={locked}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="zoom-description" className="font-mono text-xs">
              DESCRIPTION (optional)
            </Label>
            <Textarea
              id="zoom-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={locked}
            />
          </div>

          {(stage === "streaming" || stage === "registering") && (
            <div className="border border-primary/40 bg-primary/5 rounded-sm p-4 space-y-3">
              <div className="flex items-center gap-2 font-mono text-xs text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />
                {stage === "streaming"
                  ? "Streaming Zoom recording → IPFS…"
                  : "Registering on TXC & starting transcode…"}
              </div>
              {stage === "streaming" && resolved.sizeBytes ? (
                <>
                  <Progress value={pct} className="h-2" />
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {bytesUploaded > 0
                      ? `${formatBytes(bytesUploaded)} / ${formatBytes(resolved.sizeBytes)} (${pct.toFixed(0)}%)`
                      : "Pulling from Zoom — large recordings can take several minutes."}
                  </div>
                </>
              ) : (
                <div className="font-mono text-[11px] text-muted-foreground">
                  Bytes flow Zoom → our worker → IPFS. Don't close the tab.
                  After pinning, HLS transcode runs in the background and
                  produces an audio file we transcribe with AI — the
                  transcript appears on the watch page within a few minutes.
                </div>
              )}
            </div>
          )}

          <Button
            type="button"
            size="lg"
            onClick={handleImport}
            disabled={!title || locked}
            className="w-full font-mono"
          >
            {stage === "idle" || stage === "ready" ? (
              <>
                <Video className="mr-2 h-4 w-4" />
                Import recording & transcribe
              </>
            ) : (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {stage === "streaming" && "Streaming…"}
                {stage === "registering" && "Finalizing…"}
              </>
            )}
          </Button>
        </>
      )}
    </div>
  );
}