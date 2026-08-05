import { useEffect, useRef } from "react";
import Hls from "hls.js";

interface VideoPlayerProps {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  startAt?: number;
  className?: string;
}

export function VideoPlayer({
  src,
  poster,
  autoPlay = false,
  muted = false,
  startAt = 0,
  className,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    const isHls = src.split(/[?#]/, 1)[0]?.endsWith(".m3u8") ?? false;

    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      // Native MP4 / Safari HLS
      video.src = src;
    }

    if (startAt > 0) {
      const onMeta = () => {
        video.currentTime = startAt;
        video.removeEventListener("loadedmetadata", onMeta);
      };
      video.addEventListener("loadedmetadata", onMeta);
    }

    return () => {
      if (hls) hls.destroy();
    };
  }, [src, startAt]);

  return (
    <video
      ref={videoRef}
      poster={poster}
      controls
      autoPlay={autoPlay}
      muted={muted}
      playsInline
      className={className ?? "w-full h-full bg-black"}
    />
  );
}