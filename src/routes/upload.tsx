import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useWallet } from "@/lib/wallet";
import { quoteFee, formatTxc, formatBytes, MAX_UPLOAD_BYTES } from "@/lib/fees";
import { finalizeUpload } from "@/lib/videos.functions";
import { toast } from "sonner";
import { Upload, Loader2, Wallet, FileVideo } from "lucide-react";

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

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [months, setMonths] = useState(1);
  const [stage, setStage] = useState<
    "idle" | "paying" | "uploading" | "pinning" | "stamping"
  >("idle");

  const fee = file ? quoteFee(file.size, months) : 0;
  const tooBig = !!file && file.size > MAX_UPLOAD_BYTES;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !address || !title) return;
    if (tooBig) {
      toast.error(`File too large. Max ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }

    try {
      // 1. Mock payment confirmation
      setStage("paying");
      await new Promise((r) => setTimeout(r, 800));

      // 2. Encode file to base64
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
      toast.success("Pinned and timestamped on-chain");
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
          [ STEP 1 OF 1 · NO ACCOUNT REQUIRED ]
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Upload video</h1>
        <p className="text-muted-foreground mb-10">
          Pin to IPFS. Pay in TXC. Timestamp on-chain. Get an embeddable player.
        </p>

        {!address ? (
          <div className="border border-border bg-card rounded-sm p-12 text-center">
            <Wallet className="h-8 w-8 text-primary mx-auto mb-4" />
            <h2 className="font-bold mb-2">Connect a wallet to continue</h2>
            <p className="text-sm text-muted-foreground mb-6 font-mono">
              No signup. Just sign with your wallet.
            </p>
            <Button onClick={connect} className="font-mono">
              Connect Wallet
            </Button>
          </div>
        ) : (
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

            <div className="space-y-2">
              <Label className="font-mono text-xs">MONTHS PREPAID</Label>
              <div className="flex gap-2">
                {[1, 3, 6, 12].map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMonths(m)}
                    className={`flex-1 py-2 border rounded-sm font-mono text-sm transition-colors ${
                      months === m
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border hover:border-primary"
                    }`}
                  >
                    {m}mo
                  </button>
                ))}
              </div>
            </div>

            {/* Quote */}
            {file && !tooBig && (
              <div className="border border-border bg-card rounded-sm p-4 font-mono text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">size</span>
                  <span>{formatBytes(file.size)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">months</span>
                  <span>{months}</span>
                </div>
                <div className="flex justify-between border-t border-border pt-2 mt-2">
                  <span className="text-muted-foreground">total</span>
                  <span className="text-primary font-bold">
                    {formatTxc(fee)}
                  </span>
                </div>
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              disabled={!file || !title || tooBig || stage !== "idle"}
              className="w-full font-mono"
            >
              {stage === "idle" && (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Pay {file ? formatTxc(fee) : ""} & upload
                </>
              )}
              {stage !== "idle" && (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {stage === "paying" && "Confirming payment…"}
                  {stage === "uploading" && "Encoding…"}
                  {stage === "pinning" && "Pinning to IPFS…"}
                  {stage === "stamping" && "Timestamping on TXC…"}
                </>
              )}
            </Button>
          </form>
        )}
      </main>
      <Footer />
    </div>
  );
}