// "Import from URL" tab on /upload.
//
// Flow:
//   1. User pastes a WeTransfer or Dropbox link.
//   2. resolveImportUrl returns { filename, sizeBytes, token }.
//   3. User fills in title / description, clicks Pin to IPFS.
//   4. POST /api/public/import-stream with the token; the server fetches
//      the file from WT/Dropbox and pipes it into Pinata. Endpoint returns
//      { id, cid }.
//   5. While streaming, we poll getImportStatus(id) every 1s for the
//      progress bar. (XHR onprogress only sees bytes the *browser* sends,
//      so we have to ask the server how far through it is.)
//   6. Once we have a CID, hand off to the existing addByCid flow, which
//      registers it and bumps the user into the standard payment / stamp
//      pipeline — same as a normal upload from there on.

import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Loader2,
  Sparkles,
  Link2,
  AlertTriangle,
  CheckCircle2,
  Globe,
  Rocket,
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

interface Resolved {
  source: string;
  filename: string;
  sizeBytes: number | null;
  token: string;
}

export function UrlImportTab({ ownerWallet, onDuplicate }: Props) {
  const resolve = useServerFn(resolveImportUrl);
  const status = useServerFn(getImportStatus);
  const addCid = useServerFn(addByCid);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [bytesUploaded, setBytesUploaded] = useState(0);
  const [importId, setImportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stop polling on unmount.
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  async function handleResolve() {
    setError(null);
    setStage("resolving");
    setResolved(null);
    try {
      const r = await resolve({ data: { url: url.trim() } });
      setResolved(r);
      // Default title from the filename, minus extension.
      if (!title) setTitle(r.filename.replace(/\.[^.]+$/, ""));
      setStage("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resolve link";
      setError(msg);
      setStage("idle");
    }
  }

  async function handlePin() {
    if (!resolved || !title) return;
    setError(null);
    setStage("streaming");
    setBytesUploaded(0);
    setImportId(null);

    try {
      // The endpoint streams NDJSON: first line is {id}, last line is
      // {cid} on success or {error} on failure. We start polling for
      // progress as soon as we have the id.
      const res = await fetch("/api/public/import-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resolved.token }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Stream failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let id: string | null = null;
      let finalCid: string | null = null;
      let finalErr: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line) as {
              id?: string;
              cid?: string;
              error?: string;
            };
            if (obj.id && !id) {
              id = obj.id;
              setImportId(id);
              startPolling(id);
            }
            if (obj.cid) finalCid = obj.cid;
            if (obj.error) finalErr = obj.error;
          } catch {
            // ignore malformed line
          }
        }
      }

      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (finalErr) throw new Error(finalErr);
      if (!finalCid) throw new Error("Stream ended without a CID");

      setStage("registering");
      const result = await addCid({
        data: {
          wallet: ownerWallet ?? undefined,
          cid: finalCid,
          title,
          description,
          months: 1,
        },
      });
      if (result.chainStatus === "stamp_failed") {
        toast.error("Pinned to IPFS, but TXC stamp failed");
      } else {
        toast.success(`Imported from ${resolved.source} → IPFS`);
      }
      if (!ownerWallet) recordAnonUpload(result.cid, title);
      qc.invalidateQueries({ queryKey: ["recent-videos"] });
      setStage("done");
      navigate({ to: "/v/$cid", params: { cid: result.cid } });
    } catch (err) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      const dup = parseDuplicateCidError(err);
      if (dup) {
        onDuplicate(dup);
        toast.error("This video is already on stream.");
      } else {
        const msg = err instanceof Error ? err.message : "Import failed";
        setError(msg);
        toast.error(msg);
      }
      setStage("ready");
    }
  }

  function startPolling(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const row = await status({ data: { id } });
        if (typeof row.bytes_uploaded === "number") {
          setBytesUploaded(Number(row.bytes_uploaded));
        }
      } catch {
        // poll errors are non-fatal — the stream itself is the source of truth.
      }
    }, 1000);
  }

  const pct = (() => {
    if (!resolved?.sizeBytes || !bytesUploaded) return 0;
    return Math.min(100, (bytesUploaded / resolved.sizeBytes) * 100);
  })();

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="import-url" className="font-mono text-xs">
          WETRANSFER OR DROPBOX URL
        </Label>
        <div className="flex gap-2">
          <Input
            id="import-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://wetransfer.com/downloads/…  or  https://www.dropbox.com/s/…"
            disabled={stage === "resolving" || stage === "streaming"}
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleResolve}
            disabled={!url.trim() || stage === "resolving" || stage === "streaming"}
            className="font-mono shrink-0"
          >
            {stage === "resolving" ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Resolving
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-3 w-3" /> Resolve
              </>
            )}
          </Button>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          We'll find the actual file behind the share page and pin it
          straight to IPFS. Single-file transfers only, up to 10 GB.
          WeTransfer links expire — resolve fresh ones.
        </p>
      </div>

      {error && (
        <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs text-destructive mb-1">
                [ IMPORT FAILED ]
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
                  [ Resolved · {resolved.source} ]
                </div>
                <div className="font-mono text-sm truncate">
                  {resolved.filename}
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {resolved.sizeBytes
                    ? formatBytes(resolved.sizeBytes)
                    : "Size unknown"}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-title" className="font-mono text-xs">
              TITLE
            </Label>
            <Input
              id="import-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={200}
              className="font-mono"
              disabled={stage === "streaming" || stage === "registering"}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-description" className="font-mono text-xs">
              DESCRIPTION (optional)
            </Label>
            <Textarea
              id="import-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={stage === "streaming" || stage === "registering"}
            />
          </div>

          {(stage === "streaming" || stage === "registering") && (
            <div className="border border-primary/40 bg-primary/5 rounded-sm p-4 space-y-3">
              <div className="flex items-center gap-2 font-mono text-xs text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />
                {stage === "streaming"
                  ? `Streaming ${resolved.filename} → IPFS…`
                  : "Registering on TXC…"}
              </div>
              {stage === "streaming" && resolved.sizeBytes ? (
                <>
                  <Progress value={pct} className="h-2" />
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {bytesUploaded > 0
                      ? `${formatBytes(bytesUploaded)} / ${formatBytes(resolved.sizeBytes)} (${pct.toFixed(0)}%)`
                      : "Connecting to source…"}
                  </div>
                </>
              ) : (
                <div className="font-mono text-[11px] text-muted-foreground">
                  This can take a while for big files — the bytes flow{" "}
                  source → our worker → Pinata. Don't close the tab.
                </div>
              )}
            </div>
          )}

          <Button
            type="button"
            size="lg"
            onClick={handlePin}
            disabled={
              !title ||
              stage === "streaming" ||
              stage === "registering" ||
              stage === "done"
            }
            className="w-full font-mono"
          >
            {stage === "streaming" || stage === "registering" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {stage === "streaming" ? "Streaming…" : "Finalizing…"}
              </>
            ) : (
              <>
                <Rocket className="mr-2 h-4 w-4" /> Pin to IPFS
              </>
            )}
          </Button>
        </>
      )}

      {!resolved && stage === "idle" && (
        <div className="border border-border rounded-sm p-4 bg-card/50">
          <div className="flex items-start gap-3">
            <Globe className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-mono text-xs text-muted-foreground uppercase">
                Supported sources
              </div>
              <ul className="text-sm text-muted-foreground space-y-0.5">
                <li>
                  <Link2 className="inline h-3 w-3 mr-1" /> WeTransfer
                  share links (single-file)
                </li>
                <li>
                  <Link2 className="inline h-3 w-3 mr-1" /> Dropbox
                  share links (any file)
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}