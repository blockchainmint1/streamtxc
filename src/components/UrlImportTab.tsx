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
import { ThumbnailPicker } from "@/components/ThumbnailPicker";
import {
  resolveImportUrl,
  getImportStatus,
  getDropboxAppKey,
} from "@/lib/imports.functions";
import { addByCid } from "@/lib/videos.functions";
import { formatBytes } from "@/lib/fees";
import { recordAnonUpload } from "@/lib/anon-uploads";
import { parseDuplicateCidError } from "@/lib/duplicate-cid";

interface Props {
  ownerWallet: string | null;
  onDuplicate: (info: ReturnType<typeof parseDuplicateCidError>) => void;
  /**
   * "url"     — paste a Dropbox/Drive/WeTransfer link (no Chooser button)
   * "dropbox" — Dropbox Chooser only, no manual URL field
   */
  mode?: "url" | "dropbox";
}

type Stage =
  | "idle"
  | "resolving"
  | "ready"
  | "streaming"
  | "thumb"
  | "registering"
  | "done";

interface Resolved {
  source: string;
  filename: string;
  sizeBytes: number | null;
  token: string;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function UrlImportTab({ ownerWallet, onDuplicate, mode = "url" }: Props) {
  const isDropbox = mode === "dropbox";
  const resolve = useServerFn(resolveImportUrl);
  const status = useServerFn(getImportStatus);
  const addCid = useServerFn(addByCid);
  const fetchDbxKey = useServerFn(getDropboxAppKey);
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
  const [pinnedCid, setPinnedCid] = useState<string | null>(null);
  const [thumbnailCid, setThumbnailCid] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dbxReady, setDbxReady] = useState(false);

  // Stop polling on unmount.
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  // Load the Dropbox Chooser SDK once, using the app key from the server.
  useEffect(() => {
    if (!isDropbox) return; // only load SDK when the Dropbox tab needs it
    let cancelled = false;
    if (typeof window === "undefined") return;
    if ((window as any).Dropbox?.choose) {
      setDbxReady(true);
      return;
    }
    if (document.getElementById("dropboxjs")) {
      const check = setInterval(() => {
        if ((window as any).Dropbox?.choose) {
          setDbxReady(true);
          clearInterval(check);
        }
      }, 200);
      return () => clearInterval(check);
    }
    (async () => {
      try {
        const { appKey } = await fetchDbxKey({});
        if (!appKey || cancelled) return;
        const s = document.createElement("script");
        s.id = "dropboxjs";
        s.src = "https://www.dropbox.com/static/api/2/dropins.js";
        s.setAttribute("data-app-key", appKey);
        s.onload = () => {
          if (!cancelled) setDbxReady(true);
        };
        document.body.appendChild(s);
      } catch {
        /* leave dbxReady false — URL paste still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchDbxKey, isDropbox]);

  function handleDropboxChoose() {
    const Dropbox = (window as any).Dropbox;
    if (!Dropbox?.choose) return;
    Dropbox.choose({
      success: (files: Array<{ link: string; name: string; bytes: number }>) => {
        if (!files?.[0]) return;
        const f = files[0];
        setUrl(f.link);
        // The Chooser's `link` is a ONE-SHOT direct URL — if our resolver
        // burns it on a HEAD probe, the streaming GET that follows will
        // hang forever. Pass the SDK's filename + bytes through so the
        // server can skip the probe entirely.
        void handleResolve(f.link, {
          source: "dropbox",
          filename: f.name,
          sizeBytes: f.bytes,
        });
      },
      cancel: () => {},
      linkType: "direct",
      multiselect: false,
      extensions: ["video"],
    });
  }

  async function handleResolve(
    overrideUrl?: string,
    prefetched?: { source: "dropbox"; filename: string; sizeBytes: number },
  ) {
    const target = (overrideUrl ?? url).trim();
    if (!target) return;
    setError(null);
    setStage("resolving");
    setResolved(null);
    try {
      const r = await resolve({ data: { url: target, prefetched } });
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
      // Kick off the import. The endpoint returns 202 immediately with
      // {id} and runs the upload in the background via ctx.waitUntil so
      // multi-GB transfers aren't bound to the HTTP response lifetime.
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
      setImportId(id);

      // Poll until done/failed. Server updates bytes_uploaded as bytes flow
      // through, so we get a live progress bar without holding the response
      // stream open.
      const finalCid = await pollUntilDone(id);

      // Stream complete — let the user pick a thumbnail before we
      // finalize. They can also skip.
      setPinnedCid(finalCid);
      setStage("thumb");
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

  async function pollUntilDone(id: string): Promise<string> {
    // Poll ~once per second forever — large files can legitimately take
    // many minutes. We watch bytes_uploaded too; if it stalls for too long
    // and status is still 'streaming' we don't kill it (the upstream may
    // just be slow), but we surface a hint in the UI.
    while (true) {
      let row;
      try {
        row = await status({ data: { id } });
      } catch {
        // transient errors — keep polling
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

  async function handleRegister() {
    if (!pinnedCid || !resolved) return;
    setStage("registering");
    try {
      const result = await addCid({
        data: {
          wallet: ownerWallet ?? undefined,
          cid: pinnedCid,
          title,
          description,
          months: 1,
          thumbnailCid: thumbnailCid ?? undefined,
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
      const dup = parseDuplicateCidError(err);
      if (dup) {
        onDuplicate(dup);
        toast.error("This video is already on stream.");
      } else {
        const msg = err instanceof Error ? err.message : "Register failed";
        setError(msg);
        toast.error(msg);
      }
      setStage("thumb");
    }
  }

  const pct = (() => {
    if (!resolved?.sizeBytes || !bytesUploaded) return 0;
    return Math.min(100, (bytesUploaded / resolved.sizeBytes) * 100);
  })();

  return (
    <div className="space-y-6">
      {!isDropbox && (
      <div className="space-y-2">
        <Label htmlFor="import-url" className="font-mono text-xs">
          DROPBOX, GOOGLE DRIVE, OR WETRANSFER URL
        </Label>
        <div className="flex gap-2">
          <Input
            id="import-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="dropbox.com/s/…  ·  drive.google.com/file/d/…  ·  wetransfer.com/downloads/…"
            disabled={stage === "resolving" || stage === "streaming"}
            className="font-mono"
          />
          <Button
            id="import-resolve-btn"
            type="button"
            variant="outline"
            onClick={() => handleResolve()}
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
          Google Drive files must be shared as "Anyone with the link".
          WeTransfer links expire fast — resolve fresh ones.
        </p>
      </div>
      )}

      {isDropbox && (
        <div className="space-y-2">
          <Label className="font-mono text-xs">DROPBOX FILE</Label>
          <div className="flex items-center gap-2">
          <Button
            type="button"
            size="lg"
            onClick={handleDropboxChoose}
            disabled={!dbxReady || stage === "resolving" || stage === "streaming"}
            className="font-mono"
          >
            <Link2 className="mr-2 h-3 w-3" />
            {dbxReady ? "Choose from Dropbox" : "Loading Dropbox…"}
          </Button>
          {stage === "resolving" && (
            <span className="font-mono text-[11px] text-muted-foreground">
              <Loader2 className="inline h-3 w-3 mr-1 animate-spin" />
              Resolving…
            </span>
          )}
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">
            Opens Dropbox's native file picker — sign in with your Dropbox
            account, choose a video, and we'll stream it straight to IPFS.
            No need to copy a share link. Up to 10 GB.
          </p>
        </div>
      )}

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
                      : `Copying from ${resolved.source} to IPFS… (large files can take several minutes)`}
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

          {stage === "thumb" && pinnedCid && (
            <div className="border border-primary/40 bg-primary/5 rounded-sm p-4 space-y-3">
              <div className="font-mono text-xs text-primary">
                [ PINNED TO IPFS · PICK A THUMBNAIL ]
              </div>
              <ThumbnailPicker
                key={pinnedCid}
                videoSrc={`/api/stream/${pinnedCid}`}
                onChange={setThumbnailCid}
              />
              <p className="font-mono text-[11px] text-muted-foreground">
                Optional — you can skip this and add one later from the
                video page.
              </p>
            </div>
          )}

          <Button
            type="button"
            size="lg"
            onClick={stage === "thumb" ? handleRegister : handlePin}
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
            ) : stage === "thumb" ? (
              <>
                <Rocket className="mr-2 h-4 w-4" />
                {thumbnailCid ? "Register with thumbnail" : "Skip thumbnail & register"}
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
        !isDropbox && (
        <div className="border border-border rounded-sm p-4 bg-card/50">
          <div className="flex items-start gap-3">
            <Globe className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-mono text-xs text-muted-foreground uppercase">
                Supported sources
              </div>
              <ul className="text-sm text-muted-foreground space-y-0.5">
                <li>
                  <Link2 className="inline h-3 w-3 mr-1" /> Dropbox share links
                </li>
                <li>
                  <Link2 className="inline h-3 w-3 mr-1" /> Google Drive
                  ("Anyone with the link")
                </li>
                <li>
                  <Link2 className="inline h-3 w-3 mr-1" /> WeTransfer
                  share links (single-file, flaky)
                </li>
              </ul>
            </div>
          </div>
        </div>
        )
      )}
    </div>
  );
}