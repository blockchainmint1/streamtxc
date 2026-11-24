import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { pinThumbnail } from "@/lib/videos.functions";
import { Loader2, ImageIcon, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  /** Provide a local File (upload tab) — fastest, no network. */
  file?: File;
  /** OR provide a URL (CID/import tabs) — pulled via crossOrigin="anonymous". */
  videoSrc?: string;
  onChange: (cid: string | null) => void;
  /** Optional: notified while a frame is being captured/pinned, so the
   *  parent can disable its Submit button until the thumbnail CID is ready. */
  onPinningChange?: (pinning: boolean) => void;
}

/**
 * Browser-side thumbnail picker. Loads the chosen video file into a hidden
 * <video> element, lets the user scrub a slider to pick a frame, captures
 * it to a JPEG via canvas, and pins to IPFS (returning the CID through
 * onChange). Auto-captures the frame at ~1s when the file changes so the
 * user always has a reasonable default without clicking anything.
 */
export function ThumbnailPicker({ file, videoSrc, onChange, onPinningChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const pin = useServerFn(pinThumbnail);

  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(1);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [thumbCid, setThumbCid] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "capturing" | "pinning">("idle");

  // Mirror stage → parent so the upload form can wait for a mid-flight pin.
  useEffect(() => {
    onPinningChange?.(stage !== "idle");
  }, [stage, onPinningChange]);

  // Build & tear down the video source when file/url changes.
  useEffect(() => {
    let url: string | null = null;
    let hls: Hls | null = null;
    const v = videoRef.current;
    if (file) {
      url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      if (v) {
        v.src = url;
        v.load();
      }
    } else if (videoSrc && v) {
      // Transcoded videos are HLS playlists; browsers other than Safari need hls.js.
      const isHls = videoSrc.split(/[?#]/, 1)[0]?.endsWith(".m3u8") ?? false;
      if (isHls && Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 10 });
        hls.loadSource(videoSrc);
        hls.attachMedia(v);
      } else {
        v.src = videoSrc;
        v.load();
      }
    }
    setThumbCid(null);
    onChange(null);
    setPreviewUrl(null);
    return () => {
      if (url) URL.revokeObjectURL(url);
      hls?.destroy();
      objectUrlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, videoSrc]);

  // When metadata loads, default the seek time to ~1s (or 10% if very short).
  function handleLoaded() {
    const v = videoRef.current;
    if (!v) return;
    const d = isFinite(v.duration) ? v.duration : 0;
    setDuration(d);
    const t = d > 2 ? 1 : d * 0.1;
    setTime(t);
    v.currentTime = t;
  }

  // Seek when the slider moves.
  function handleSeek(value: number[]) {
    const t = value[0] ?? 0;
    setTime(t);
    const v = videoRef.current;
    if (v) v.currentTime = t;
  }

  // Capture current frame -> jpeg blob -> base64 -> pin.
  async function captureAndPin() {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return;
    setStage("capturing");
    try {
      // Cap thumbnail dimensions so the pinned blob stays small.
      const maxW = 1280;
      const ratio = v.videoHeight / v.videoWidth;
      const w = Math.min(v.videoWidth, maxW);
      const h = Math.round(w * ratio);
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("canvas context unavailable");
      ctx.drawImage(v, 0, 0, w, h);
      const blob: Blob | null = await new Promise((resolve) =>
        c.toBlob((b) => resolve(b), "image/jpeg", 0.85),
      );
      if (!blob) throw new Error("could not encode thumbnail");

      // Show local preview immediately.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));

      // base64 the bytes for the server fn payload.
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const b64 = btoa(bin);

      setStage("pinning");
      const result = await pin({
        data: { imageBase64: b64, mimeType: "image/jpeg" },
      });
      setThumbCid(result.cid);
      onChange(result.cid);
    } catch (err) {
      console.error("thumbnail capture failed", err);
      toast.error(
        err instanceof Error ? err.message : "Couldn't capture thumbnail",
      );
    } finally {
      setStage("idle");
    }
  }

  return (
    <div className="space-y-3">
      <Label className="font-mono text-xs">THUMBNAIL</Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="aspect-video bg-black border border-border rounded-sm overflow-hidden relative">
          <video
            ref={videoRef}
            muted
            playsInline
            preload="metadata"
            crossOrigin="anonymous"
            onLoadedMetadata={handleLoaded}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </div>
        <div className="aspect-video bg-secondary border border-border rounded-sm overflow-hidden relative flex items-center justify-center">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="thumbnail preview"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="text-center text-muted-foreground font-mono text-xs px-4">
              <ImageIcon className="h-6 w-6 mx-auto mb-1 opacity-60" />
              click "use this frame" to capture
            </div>
          )}
          {thumbCid && (
            <div className="absolute bottom-1 right-1 bg-background/80 text-primary font-mono text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> pinned
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex justify-between font-mono text-xs text-muted-foreground">
          <span>scrub to choose frame</span>
          <span>
            {time.toFixed(1)}s / {duration ? duration.toFixed(1) : "…"}s
          </span>
        </div>
        <Slider
          value={[time]}
          min={0}
          max={Math.max(0.1, duration)}
          step={0.1}
          onValueChange={handleSeek}
          disabled={!duration}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="font-mono"
          onClick={captureAndPin}
          disabled={!duration || stage !== "idle"}
        >
          {stage === "idle" && "use this frame"}
          {stage === "capturing" && (
            <>
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> capturing…
            </>
          )}
          {stage === "pinning" && (
            <>
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> pinning to IPFS…
            </>
          )}
        </Button>
        {thumbCid && (
          <span className="font-mono text-[11px] text-muted-foreground truncate">
            {thumbCid}
          </span>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}