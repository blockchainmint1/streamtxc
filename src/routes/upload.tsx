import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useWallet } from "@/lib/wallet";
import { formatDate } from "@/lib/fees";
import { addByCid } from "@/lib/videos.functions";
import { ThumbnailPicker } from "@/components/ThumbnailPicker";
import { recordAnonUpload } from "@/lib/anon-uploads";
import { UrlImportTab } from "@/components/UrlImportTab";
import { S3VideoUpload } from "@/components/S3VideoUpload";
import {
  Upload,
  Link2,
  Cloud,
  Sparkles,
  Loader2,
  AlertTriangle,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import {
  parseDuplicateCidError,
  shortWallet,
  type DuplicateCidInfo,
} from "@/lib/duplicate-cid";

export const Route = createFileRoute("/upload")({
  head: () => ({
    meta: [
      { title: "Upload — streamTXC" },
      {
        name: "description",
        content:
          "Upload a video, paste an IPFS CID, choose from Dropbox, or import from a URL. Pin to IPFS, transcode to HLS, pay in TXC.",
      },
    ],
  }),
  component: UploadPage,
});

type TabKey = "file" | "cid" | "dropbox" | "import";

function UploadPage() {
  const { address } = useWallet();
  const [tab, setTab] = useState<TabKey>("file");
  const [duplicate, setDuplicate] = useState<DuplicateCidInfo | null>(null);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl px-6 py-12 flex-1 space-y-8">
        <div>
          <div className="font-mono text-xs text-primary mb-3">
            [ PAY-AS-YOU-GO · NO ACCOUNT REQUIRED ]
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-2">Upload video</h1>
          <p className="text-muted-foreground">
            Pin to IPFS. Pay in TXC. Get an embeddable player and an on-chain
            timestamp receipt.
          </p>
        </div>

        {duplicate && (
          <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-destructive mb-1">
                  [ ALREADY ON STREAM ]
                </div>
                <div className="font-bold mb-2">"{duplicate.title}"</div>
                <p className="text-sm text-muted-foreground mb-3">
                  This exact content (CID match) was published by{" "}
                  <span className="font-mono text-foreground">
                    {shortWallet(duplicate.ownerWallet)}
                  </span>{" "}
                  on {formatDate(duplicate.createdAt)}. First wallet to stamp wins.
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

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
          <TabsList className="grid w-full grid-cols-4 mb-6">
            <TabsTrigger value="file" className="font-mono text-xs">
              <Upload className="mr-2 h-3 w-3" /> Upload file
            </TabsTrigger>
            <TabsTrigger value="cid" className="font-mono text-xs">
              <Link2 className="mr-2 h-3 w-3" /> Add by CID
            </TabsTrigger>
            <TabsTrigger value="dropbox" className="font-mono text-xs">
              <Cloud className="mr-2 h-3 w-3" /> Dropbox
            </TabsTrigger>
            <TabsTrigger value="import" className="font-mono text-xs">
              <Sparkles className="mr-2 h-3 w-3" /> Import URL
            </TabsTrigger>
          </TabsList>

          {tab !== "file" && (
            <div className="mb-6 border border-amber-500/40 bg-amber-500/5 rounded-sm p-4 flex items-start gap-3">
              <Info className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">
                <span className="text-amber-500">[ HEADS UP ]</span> Videos added
                via CID, Dropbox, or URL are pinned to IPFS and stamped on-chain,
                but they <span className="text-foreground">don't go through the
                MediaConvert HLS pipeline</span> — playback uses the original
                file directly. Only files uploaded through the{" "}
                <span className="text-foreground">Upload file</span> tab get the
                adaptive HLS ladder.
              </p>
            </div>
          )}

          <TabsContent value="file">
            <S3VideoUpload showLogByDefault={false} destination="v2" />
          </TabsContent>

          <TabsContent value="cid">
            <CidTab
              ownerWallet={address ?? null}
              onDuplicate={(d) => setDuplicate(d)}
            />
          </TabsContent>

          <TabsContent value="dropbox">
            <UrlImportTab
              ownerWallet={address ?? null}
              onDuplicate={(info) => info && setDuplicate(info)}
              mode="dropbox"
            />
          </TabsContent>

          <TabsContent value="import">
            <UrlImportTab
              ownerWallet={address ?? null}
              onDuplicate={(info) => info && setDuplicate(info)}
              mode="url"
            />
          </TabsContent>
        </Tabs>
      </main>
      <Footer />
    </div>
  );
}

function CidTab({
  ownerWallet,
  onDuplicate,
}: {
  ownerWallet: string | null;
  onDuplicate: (d: DuplicateCidInfo) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const addCid = useServerFn(addByCid);
  const [cid, setCid] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [thumbnailCid, setThumbnailCid] = useState<string | null>(null);
  const [nsfw, setNsfw] = useState(false);
  const [stage, setStage] = useState<"idle" | "fetching" | "registering">("idle");
  const [notFound, setNotFound] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cid || !title) return;
    setNotFound(null);
    try {
      setStage("fetching");
      const result = await addCid({
        data: {
          wallet: ownerWallet ?? undefined,
          cid: cid.trim(),
          title,
          description,
          months: 1,
          thumbnailCid: thumbnailCid ?? undefined,
          nsfw,
        },
      });
      if (result.chainStatus === "stamp_failed") {
        toast.error("CID saved, but TXC stamp failed");
      } else {
        toast.success("CID registered");
      }
      if (!ownerWallet) recordAnonUpload(result.cid, title);
      qc.invalidateQueries({ queryKey: ["recent-videos"] });
      navigate({ to: "/v/$cid", params: { cid: result.cid } });
    } catch (err) {
      const dup = parseDuplicateCidError(err);
      if (dup) {
        onDuplicate(dup);
        toast.error("This CID is already on stream.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("CID_NOT_FOUND")) {
          const detail = msg.split("CID_NOT_FOUND:")[1] ?? "";
          setNotFound(detail || "We couldn't find that CID on IPFS.");
          toast.error("CID not found on IPFS");
        } else {
          toast.error(msg || "Failed to register CID");
        }
      }
      setStage("idle");
    }
  }

  const cidLooksValid =
    /^(bafy|bafk|bafyb|Qm)/i.test(cid.trim()) && cid.trim().length >= 46;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {notFound && (
        <div className="border-2 border-destructive/60 bg-destructive/5 rounded-sm p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs text-destructive mb-1">
                [ CID NOT FOUND ON IPFS ]
              </div>
              <p className="text-sm text-muted-foreground">
                {notFound} Make sure the file is pinned somewhere public
                (Pinata, web3.storage, your own node) and try again.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="cid" className="font-mono text-xs">IPFS CID</Label>
        <Input
          id="cid"
          value={cid}
          onChange={(e) => setCid(e.target.value)}
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
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={200}
          className="font-mono"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cid-description" className="font-mono text-xs">DESCRIPTION (optional)</Label>
        <Textarea
          id="cid-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
        />
      </div>

      {cidLooksValid && (
        <ThumbnailPicker
          key={cid.trim()}
          videoSrc={`/api/stream/${cid.trim()}`}
          onChange={setThumbnailCid}
        />
      )}

      <label className="flex items-start gap-3 border border-border bg-card rounded-sm p-4 cursor-pointer">
        <Checkbox checked={nsfw} onCheckedChange={(v) => setNsfw(v === true)} className="mt-0.5" />
        <div className="flex-1">
          <div className="font-mono text-xs">[ NSFW / ADULT CONTENT ]</div>
          <p className="text-xs text-muted-foreground mt-1">
            Hidden from homepage and public listings.
          </p>
        </div>
      </label>

      {stage !== "idle" && (
        <div className="border border-primary/40 bg-primary/5 rounded-sm p-4">
          <div className="flex items-center gap-2 font-mono text-xs text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            {stage === "fetching" ? "Fetching CID from IPFS…" : "Stamping on TXC…"}
          </div>
        </div>
      )}

      <Button
        type="submit"
        size="lg"
        disabled={!cid || !title || stage !== "idle"}
        className="w-full font-mono"
      >
        {stage === "idle" ? (
          <><Link2 className="mr-2 h-4 w-4" /> Register CID</>
        ) : (
          <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Working…</>
        )}
      </Button>
    </form>
  );
}