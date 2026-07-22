import { useEffect, useRef, useState } from "react";
import Hls, { type Level } from "hls.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Settings, Gauge, Layers, VolumeX } from "lucide-react";

interface VideoPlayerV2Props {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  startAt?: number;
  className?: string;
  /** Show small "HLS" / "MP4" badge in the corner. */
  showSourceBadge?: boolean;
  /**
   * When true, render a big centered "Tap to unmute" overlay while the
   * video is muted. Needed for autoplay-muted live streams on mobile,
   * where the native volume control is easy to miss.
   */
  showTapToUnmute?: boolean;
  /**
   * Optional WebVTT captions URL. When provided, a <track kind="captions">
   * is rendered and enabled by default so the browser shows CC controls.
   * Must be same-origin (or CORS-enabled) — our /api/stream/:cid proxy is
   * same-origin.
   */
  captionsSrc?: string;
  captionsLabel?: string;
  captionsLang?: string;
  /**
   * When true, snap playback to the live edge on load. Prevents replaying
   * archived segments from an EVENT-type HLS manifest (MediaPackage retains
   * prior session history in the same endpoint).
   */
  isLive?: boolean;
}

const QUALITY_KEY = "txc-player-quality";
const SPEED_KEY = "txc-player-speed";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Enhanced HLS-first player.
 *
 * - Uses hls.js when the URL is .m3u8 and the browser doesn't natively
 *   support HLS (everyone except Safari).
 * - Quality selector built off `hls.levels`, persisted to localStorage.
 * - Playback speed menu, persisted to localStorage.
 * - Keyboard shortcuts: space, ←/→ (5s), J/L (10s), M, F, 0-9 (seek %).
 */
export function VideoPlayerV2({
  src,
  poster,
  autoPlay = false,
  muted = false,
  startAt = 0,
  className,
  showSourceBadge = true,
  showTapToUnmute = false,
  captionsSrc,
  captionsLabel = "English",
  captionsLang = "en",
  isLive = false,
}: VideoPlayerV2Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [currentLevel, setCurrentLevel] = useState<number>(-1); // -1 = auto
  const [speed, setSpeed] = useState<number>(1);
  const [mode, setMode] = useState<"hls" | "native" | "mp4">("mp4");
  const [isMuted, setIsMuted] = useState<boolean>(muted);

  // Sync `isMuted` with the actual <video> element — the browser can flip
  // it via native controls, keyboard shortcut, or autoplay policy.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onVol = () => setIsMuted(video.muted || video.volume === 0);
    onVol();
    video.addEventListener("volumechange", onVol);
    return () => video.removeEventListener("volumechange", onVol);
  }, []);

  function unmuteAndPlay() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    if (video.volume === 0) video.volume = 1;
    setIsMuted(false);
    // Kick playback in case the user tapped before it started.
    void video.play().catch(() => {});
  }

  const isHls = src.endsWith(".m3u8");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;

    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, maxBufferLength: 30 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      setMode("hls");
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels ?? []);
        // Restore persisted quality choice if it still maps to a level.
        if (typeof window !== "undefined") {
          const saved = window.localStorage.getItem(QUALITY_KEY);
          if (saved && hls) {
            const height = Number(saved);
            if (Number.isFinite(height)) {
              const idx = (data.levels ?? []).findIndex(
                (l) => l.height === height,
              );
              if (idx >= 0) {
                hls.currentLevel = idx;
                setCurrentLevel(idx);
              }
            }
          }
        }
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        setCurrentLevel(hls?.autoLevelEnabled ? -1 : data.level);
      });
    } else if (isHls) {
      // Safari / native HLS
      video.src = src;
      setMode("native");
    } else {
      video.src = src;
      setMode("mp4");
    }

    // Restore playback speed.
    if (typeof window !== "undefined") {
      const savedSpeed = Number(window.localStorage.getItem(SPEED_KEY));
      if (Number.isFinite(savedSpeed) && savedSpeed > 0) {
        video.playbackRate = savedSpeed;
        setSpeed(savedSpeed);
      }
    }

    if (startAt > 0) {
      const onMeta = () => {
        video.currentTime = startAt;
        video.removeEventListener("loadedmetadata", onMeta);
      };
      video.addEventListener("loadedmetadata", onMeta);
    }

    // Live streams: jump to the live edge whenever the seekable window
    // grows, so we never replay stale segments left in the manifest from a
    // previous session.
    let snapToLive: (() => void) | null = null;
    if (isLive) {
      snapToLive = () => {
        try {
          if (video.seekable && video.seekable.length > 0) {
            const end = video.seekable.end(video.seekable.length - 1);
            if (isFinite(end) && end - video.currentTime > 3) {
              video.currentTime = Math.max(0, end - 1);
            }
          }
        } catch {}
      };
      video.addEventListener("loadedmetadata", snapToLive);
      video.addEventListener("durationchange", snapToLive);
    }

    return () => {
      if (snapToLive) {
        video.removeEventListener("loadedmetadata", snapToLive);
        video.removeEventListener("durationchange", snapToLive);
      }
      if (hls) hls.destroy();
      hlsRef.current = null;
    };
  }, [src, startAt, isHls]);

  // Keyboard shortcuts — scoped to when our container has focus or hover.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const video = videoRef.current;
      const container = containerRef.current;
      if (!video || !container) return;
      // Ignore typing in inputs.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Only handle when the player is hovered or focused-within.
      if (!container.matches(":hover") && !container.contains(document.activeElement)) return;

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          if (video.paused) void video.play();
          else video.pause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
          break;
        case "j":
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case "l":
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          break;
        case "m":
          video.muted = !video.muted;
          break;
        case "f":
          if (document.fullscreenElement) void document.exitFullscreen();
          else void container.requestFullscreen();
          break;
        default: {
          // 0..9 → seek to N*10% of duration
          if (/^[0-9]$/.test(e.key) && video.duration) {
            const pct = Number(e.key) / 10;
            video.currentTime = video.duration * pct;
          }
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function pickQuality(levelIdx: number) {
    const hls = hlsRef.current;
    if (!hls) return;
    hls.currentLevel = levelIdx;
    setCurrentLevel(levelIdx);
    if (typeof window !== "undefined") {
      if (levelIdx === -1) window.localStorage.removeItem(QUALITY_KEY);
      else {
        const h = hls.levels[levelIdx]?.height;
        if (h) window.localStorage.setItem(QUALITY_KEY, String(h));
      }
    }
  }

  function pickSpeed(s: number) {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = s;
    setSpeed(s);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SPEED_KEY, String(s));
    }
  }

  const currentHeight =
    currentLevel === -1 || !levels[currentLevel]
      ? null
      : levels[currentLevel].height;

  return (
    <div ref={containerRef} className="relative h-full w-full bg-black group">
      <video
        ref={videoRef}
        poster={poster}
        controls
        autoPlay={autoPlay}
        muted={muted}
        playsInline
        tabIndex={0}
        className={className ?? "w-full h-full bg-black"}
      >
        {captionsSrc && (
          <track
            kind="captions"
            src={captionsSrc}
            srcLang={captionsLang}
            label={captionsLabel}
            default
          />
        )}
      </video>

      {showTapToUnmute && isMuted && (
        <button
          type="button"
          onClick={unmuteAndPlay}
          aria-label="Tap to unmute"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/40 text-white font-mono text-sm hover:bg-black/50 transition-colors"
        >
          <span className="flex items-center gap-2 rounded-full border border-white/60 bg-black/70 px-4 py-2">
            <VolumeX className="h-5 w-5" />
            <span className="uppercase tracking-wider text-xs font-bold">
              Tap to unmute
            </span>
          </span>
        </button>
      )}

      {/* Top-right overlay: source badge + settings */}
      <div className="absolute top-2 right-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        {showSourceBadge && (
          <div className="pointer-events-auto font-mono text-[10px] uppercase tracking-wider bg-black/70 text-primary border border-primary/40 px-2 py-1 rounded-sm">
            {mode === "hls"
              ? `HLS${currentHeight ? ` · ${currentHeight}p` : currentLevel === -1 ? " · auto" : ""}`
              : mode === "native"
              ? "HLS · native"
              : "MP4"}
          </div>
        )}
        <div className="pointer-events-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Player settings"
                className="bg-black/70 hover:bg-black border border-border text-foreground rounded-sm p-1.5"
              >
                <Settings className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 font-mono text-xs">
              {mode === "hls" && levels.length > 0 && (
                <>
                  <DropdownMenuLabel className="flex items-center gap-2">
                    <Layers className="h-3 w-3" /> Quality
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => pickQuality(-1)}>
                    {currentLevel === -1 ? "● " : "  "}Auto
                  </DropdownMenuItem>
                  {[...levels]
                    .map((l, i) => ({ l, i }))
                    .sort((a, b) => (b.l.height ?? 0) - (a.l.height ?? 0))
                    .map(({ l, i }) => (
                      <DropdownMenuItem key={i} onClick={() => pickQuality(i)}>
                        {currentLevel === i ? "● " : "  "}
                        {l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)}kbps`}
                      </DropdownMenuItem>
                    ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel className="flex items-center gap-2">
                <Gauge className="h-3 w-3" /> Speed
              </DropdownMenuLabel>
              {SPEEDS.map((s) => (
                <DropdownMenuItem key={s} onClick={() => pickSpeed(s)}>
                  {speed === s ? "● " : "  "}
                  {s}x
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}