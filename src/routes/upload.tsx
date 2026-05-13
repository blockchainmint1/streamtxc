import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
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
} from "@/lib/videos.functions";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Upload,
  Loader2,
  FileVideo,
  Link2,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { parseDuplicateCidError, shortWallet, type DuplicateCidInfo } from "@/lib/duplicate-cid";
import { computeCids, findCidOnIpfs } from "@/lib/ipfs-cid";
import { PinataSDK } from "pinata";
import { ThumbnailPicker } from "@/components/ThumbnailPicker";

export const Route = createFileRoute("/upload")({
  head: () => ({
    meta: [
      { title: "Upload — stream.texitcoin" },
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
 * Upload a file from the browser using a Pinata presigned URL. Pinata's
 * v3 upload endpoint speaks TUS (resumable, HEAD+PATCH+POST). The official
 * SDK with `.url(presignedUrl)` handles the protocol and gives us CIDv1.
 * Direct-to-Pinata is required because our Worker proxy can't carry video-
 * sized request bodies (CF Workers cap at ~100MB per request).
 */
const browserPinata = new PinataSDK({ pinataJwt: "" });

async function uploadToPinata(
  url: string,
  file: File,
  _onProgress: (pct: number) => void,
): Promise<{ cid: string; size: number; id: string }> {
  const result = await browserPinata.upload.public
    .file(file)
    .url(url)
    .cidVersion("v1");
  return {
    cid: result.cid,
    size: result.size ?? file.size,
    id: (result as { id?: string }).id ?? "",
  };
}

function UploadPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { address, connect } = useWallet();
  const getUrl = useServerFn(getUploadUrl);
  const register = useServerFn(registerUpload);
  const addCid = useServerFn(addByCid);
  const quoteFn = useServerFn(getQuote);

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
  const [cidStage, setCidStage] = useState<
    "idle" | "fetching" | "registering"
  >("idle");
  const [cidNotFound, setCidNotFound] = useState<string | null>(null);
  const months = 1;
  const [stage, setStage] = useState<
    "idle" | "hashing" | "checking" | "signing" | "uploading" | "registering"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [duplicate, setDuplicate] = useState<DuplicateCidInfo | null>(null);

  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

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
        const hit = await findCidOnIpfs(cids);
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
  }, [file, tooBig, quoteFn]);

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
    if (!file || !address || !title) return;
    if (tooBig) {
      toast.error(`File too large. Max ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    setDuplicate(null);

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
          : await findCidOnIpfs(cids);
      if (hit) {
        toast("Found this file on IPFS — skipping upload", {
          description: "Registering existing CID instead.",
        });
        setStage("registering");
        const result = await addCid({
          data: {
            wallet: address,
            cid: hit.cid,
            title,
            description,
            months,
            thumbnailCid: thumbnailCid ?? undefined,
          },
        });
        if (result.chainStatus === "stamp_failed") {
          toast.error("Saved from IPFS, but TXC stamp failed");
        } else {
          toast.success("Registered from IPFS");
        }
        qc.invalidateQueries({ queryKey: ["recent-videos"] });
        navigate({ to: "/v/$cid", params: { cid: result.cid } });
        return;
      }

      // 3. Not on IPFS yet — get a Pinata presigned URL and upload directly.
      setStage("signing");
      const safeName = sanitizeFilename(file.name);
      const { url } = await getUrl({
        data: { filename: safeName, sizeBytes: file.size },
      });

      setStage("uploading");
      const safeFile =
        safeName === file.name
          ? file
          : new File([file], safeName, { type: file.type });
      const pinResult = await uploadToPinata(url, safeFile, (pct) =>
        setProgress(pct),
      );

      // 5. Register metadata + on-chain stamp.
      setStage("registering");
      const result = await register({
        data: {
          wallet: address,
          cid: pinResult.cid,
          title,
          description,
          sizeBytes: pinResult.size || file.size,
          mimeType: file.type || "video/mp4",
          months,
          thumbnailCid: thumbnailCid ?? undefined,
        },
      });

      if (result.chainStatus === "stamp_failed") {
        toast.error("Pinned to IPFS, but TXC stamp failed");
      } else {
        toast.success("Pinned to IPFS");
      }
      qc.invalidateQueries({ queryKey: ["recent-videos"] });
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
    if (!cidInput || !cidTitle || !address) return;
    setDuplicate(null);
    setCidNotFound(null);
    try {
      setCidStage("fetching");
      const result = await addCid({
        data: {
          wallet: address,
          cid: cidInput.trim(),
          title: cidTitle,
          description: cidDescription,
          months,
        },
      });
      if (result.chainStatus === "stamp_failed") {
        toast.error("CID saved, but TXC stamp failed");
      } else {
        toast.success("CID registered");
      }
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

        <Tabs defaultValue="file" className="w-full">
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
          <TabsList className="grid w-full grid-cols-2 mb-6">
            <TabsTrigger value="file" className="font-mono text-xs">
              <Upload className="mr-2 h-3 w-3" /> Upload file
            </TabsTrigger>
            <TabsTrigger value="cid" className="font-mono text-xs">
              <Link2 className="mr-2 h-3 w-3" /> Add by CID
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file">
        <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label className="font-mono text-xs">VIDEO FILE</Label>
              <label className="block border-2 border-dashed border-border hover:border-primary rounded-sm p-8 cursor-pointer transition-colors bg-card">
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setFile(f);
                      setCodecWarning(checkCodec(f));
                      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
                      setThumbnailCid(null);
                    }
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
                        TOO LARGE
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="text-center">
                    <Upload className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                    <div className="font-mono text-sm">click to choose a video</div>
                    <div className="font-mono text-xs text-muted-foreground mt-1">
                      mp4 / webm / mov · max {formatBytes(MAX_UPLOAD_BYTES)}
                    </div>
                  </div>
                )}
              </label>
            </div>

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
              <ThumbnailPicker file={file} onChange={setThumbnailCid} />
            )}

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
              disabled={!file || !title || tooBig || stage !== "idle" || !address}
              className="w-full font-mono"
            >
              {stage === "idle" && (
                cidProbe === "on-ipfs" ? (
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
                  {stage === "signing" && "Requesting upload URL…"}
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
                disabled={!cidInput || !cidTitle || cidStage !== "idle" || !address}
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
        </Tabs>
      </main>
      <Footer />
    </div>
  );
}