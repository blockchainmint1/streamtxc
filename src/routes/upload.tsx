import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useWallet } from "@/lib/wallet";
import { formatBytes, formatDate, MAX_UPLOAD_BYTES } from "@/lib/fees";
import { getUploadUrl, registerUpload, addByCid } from "@/lib/videos.functions";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Upload, Loader2, FileVideo, Link2, AlertTriangle } from "lucide-react";
import { parseDuplicateCidError, shortWallet, type DuplicateCidInfo } from "@/lib/duplicate-cid";

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
 * Upload a file directly to a Pinata presigned URL using XHR so we get
 * progress events. Returns the parsed Pinata response.
 */
function uploadToPinata(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ cid: string; size: number; id: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("network", "public");
    form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText) as {
            data: { cid: string; size: number; id: string };
          };
          resolve(json.data);
        } catch (err) {
          reject(new Error("Bad response from Pinata"));
        }
      } else {
        reject(new Error(`Pinata upload failed [${xhr.status}]: ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(form);
  });
}

function UploadPage() {
  const navigate = useNavigate();
  const { address, connect } = useWallet();
  const getUrl = useServerFn(getUploadUrl);
  const register = useServerFn(registerUpload);
  const addCid = useServerFn(addByCid);

  // Auto-provision an anonymous owner id so uploads are free and frictionless
  // until the real TXC wallet integration lands.
  useEffect(() => {
    if (!address) connect();
  }, [address, connect]);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cidInput, setCidInput] = useState("");
  const [cidTitle, setCidTitle] = useState("");
  const [cidDescription, setCidDescription] = useState("");
  const [cidStage, setCidStage] = useState<"idle" | "registering">("idle");
  const months = 1;
  const [stage, setStage] = useState<
    "idle" | "signing" | "uploading" | "registering"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [duplicate, setDuplicate] = useState<DuplicateCidInfo | null>(null);

  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !address || !title) return;
    if (tooBig) {
      toast.error(`File too large. Max ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    setDuplicate(null);

    try {
      // 1. Ask our server for a presigned Pinata URL
      setStage("signing");
      setProgress(0);
      const { url } = await getUrl({
        data: { filename: file.name, sizeBytes: file.size },
      });

      // 2. Upload the file directly to Pinata with progress
      setStage("uploading");
      const pinResult = await uploadToPinata(url, file, (pct) =>
        setProgress(pct),
      );

      // 3. Register metadata + mock chain stamp
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
        },
      });

      toast.success("Pinned to IPFS");
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
    try {
      setCidStage("registering");
      const result = await addCid({
        data: {
          wallet: address,
          cid: cidInput.trim(),
          title: cidTitle,
          description: cidDescription,
          months,
        },
      });
      toast.success("CID registered");
      navigate({ to: "/v/$cid", params: { cid: result.cid } });
    } catch (err) {
      console.error(err);
      const dup = parseDuplicateCidError(err);
      if (dup) {
        setDuplicate(dup);
        toast.error("Nice try — this CID is already claimed.");
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to register CID");
      }
      setCidStage("idle");
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl px-6 py-12 flex-1">
        <div className="font-mono text-xs text-primary mb-3">
          [ FREE WHILE IN BETA · NO ACCOUNT REQUIRED ]
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Upload video</h1>
        <p className="text-muted-foreground mb-10">
          Pin to IPFS. Get an embeddable player. TXC payment + on-chain
          timestamping land once the wallet integration is live.
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
                      if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
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
              <div className="border border-border bg-card rounded-sm p-4 font-mono text-sm flex justify-between">
                <span className="text-muted-foreground">cost</span>
                <span className="text-primary font-bold">FREE (beta)</span>
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
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload to IPFS
                </>
              )}
              {stage !== "idle" && (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
                    Probing gateway…
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