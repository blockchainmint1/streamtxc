import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useWallet } from "@/lib/wallet";
import { formatBytes, MAX_UPLOAD_BYTES } from "@/lib/fees";
import { finalizeUpload } from "@/lib/videos.functions";
import { toast } from "sonner";
import { Upload, Loader2, FileVideo } from "lucide-react";

export const Route = createFileRoute("/upload")({
  head: () => ({
    meta: [
      { title: "Upload — video.texitcoin" },
      {
        name: "description",
        content:
          "Upload a video to IPFS, pay TXC for hosting, get an embeddable player.",
      },
    ],
  }),
  component: UploadPage,
});

function UploadPage() {
  const navigate = useNavigate();
  const { address, connect } = useWallet();
  const finalize = useServerFn(finalizeUpload);

  // Auto-provision an anonymous owner id so uploads are free and frictionless
  // until the real TXC wallet integration lands.
  useEffect(() => {
    if (!address) connect();
  }, [address, connect]);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const months = 1;
  const [stage, setStage] = useState<
    "idle" | "paying" | "uploading" | "pinning" | "stamping"
  >("idle");

  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !address || !title) return;
    if (tooBig) {
      toast.error(`File too large. Max ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }

    try {
      // Encode file to base64
      setStage("uploading");
      const buffer = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(bytes.subarray(i, i + chunk)),
        );
      }
      const base64 = btoa(binary);

      // 3. Pin + timestamp
      setStage("pinning");
      const result = await finalize({
        data: {
          wallet: address,
          title,
          description,
          months,
          fileBase64: base64,
          filename: file.name,
          mimeType: file.type || "video/mp4",
        },
      });

      setStage("stamping");
      toast.success("Pinned to IPFS");
      navigate({ to: "/v/$cid", params: { cid: result.cid } });
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setStage("idle");
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
                  {stage === "uploading" && "Encoding…"}
                  {stage === "pinning" && "Pinning to IPFS…"}
                  {stage === "stamping" && "Finalizing…"}
                </>
              )}
            </Button>
        </form>
      </main>
      <Footer />
    </div>
  );
}