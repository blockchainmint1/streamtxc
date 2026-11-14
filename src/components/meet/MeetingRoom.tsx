// Live meeting screen. amazon-chime-sdk-js is browser-only, so it is loaded
// with a dynamic import inside an effect (never at module scope).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, MonitorX, PhoneOff, Users, Eye, Volume2, Bell, BellOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { decodeExternalUserId, type MeetingRole } from "@/lib/meeting-rules";
import { InMeetingHostBar } from "./HostPanel";
import { playMeetSound, setSoundsMutedLocally, soundsMutedLocally } from "@/lib/meet-sound";

export interface JoinResult {
  role: MeetingRole;
  title: string;
  meeting: any;
  attendee: { AttendeeId: string; ExternalUserId: string; JoinToken: string };
  leaveToken?: string | null;
  roomId?: string | null;
  joinSound?: boolean;
}

/** Tell the server this seat is free (works even while the tab is closing). */
function sendLeave(join: JoinResult) {
  if (!join.leaveToken) return;
  const body = JSON.stringify({
    meetingId: join.meeting?.MeetingId,
    attendeeId: join.attendee.AttendeeId,
    token: join.leaveToken,
  });
  try {
    if (navigator.sendBeacon?.("/api/public/meet/leave", body)) return;
  } catch { /* fall through */ }
  void fetch("/api/public/meet/leave", { method: "POST", body, keepalive: true }).catch(() => {});
}

interface Tile { tileId: number; attendeeId: string; local: boolean; content: boolean }
interface Person { attendeeId: string; name: string; role: MeetingRole; muted: boolean; speaking: boolean }

type Status = "connecting" | "live" | "ended" | "left" | "replaced" | "failed";

export function MeetingRoom({
  join, startMic, startCam, onExit,
}: { join: JoinResult; startMic: boolean; startCam: boolean; onExit: () => void }) {
  const viewer = join.role === "viewer";
  const selfId = join.attendee.AttendeeId;
  const avRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const camStream = useRef<MediaStream | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [tiles, setTiles] = useState<Record<number, Tile>>({});
  const [people, setPeople] = useState<Record<string, Person>>({});
  const [micOn, setMicOn] = useState(false);
  const [hasMic, setHasMic] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [needsSoundTap, setNeedsSoundTap] = useState(false);
  const [busy, setBusy] = useState(false);
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

  const [soundsOff, setSoundsOff] = useState(false);
  const soundsOffRef = useRef(false);
  const joinedAt = useRef(0);
  useEffect(() => { const m = soundsMutedLocally(); setSoundsOff(m); soundsOffRef.current = m; }, []);
  function toggleSounds() {
    const next = !soundsOff;
    setSoundsOff(next);
    soundsOffRef.current = next;
    setSoundsMutedLocally(next);
  }
  const leftRef = useRef(false);
  const leaveOnce = () => {
    if (leftRef.current) return;
    leftRef.current = true;
    sendLeave(join);
  };
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => { if (!e.persisted) leaveOnce(); };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      leaveOnce();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.attendee.AttendeeId]);

  useEffect(() => {
    let cancelled = false;
    let av: any = null;
    const stopStreams = () => {
      camStream.current?.getTracks().forEach((t) => t.stop());
      micStream.current?.getTracks().forEach((t) => t.stop());
      camStream.current = null;
      micStream.current = null;
    };

    (async () => {
      try {
        // The Chime SDK reads Node's `global`; browsers only have globalThis.
        const g = globalThis as unknown as { global?: unknown };
        if (typeof g.global === "undefined") g.global = globalThis;
        const sdk = await import("amazon-chime-sdk-js");
        if (cancelled) return;
        const logger = new sdk.ConsoleLogger("meet", sdk.LogLevel.WARN);
        const devices = new sdk.DefaultDeviceController(logger);
        const config = new sdk.MeetingSessionConfiguration({ Meeting: join.meeting }, { Attendee: join.attendee });
        const session = new sdk.DefaultMeetingSession(config, logger, devices);
        av = session.audioVideo;
        avRef.current = av;

        av.addObserver({
          audioVideoDidStart: () => {
            if (cancelled) return;
            joinedAt.current = Date.now();
            setStatus("live");
          },
          audioVideoDidStop: (s: any) => {
            if (cancelled) return;
            const code = s.statusCode();
            if (code === sdk.MeetingSessionStatusCode.MeetingEnded) setStatus("ended");
            else if (code === sdk.MeetingSessionStatusCode.AudioJoinedFromAnotherDevice) setStatus("replaced");
            else if (code === sdk.MeetingSessionStatusCode.Left) setStatus("left");
            else setStatus("failed");
            stopStreams();
          },
          videoTileDidUpdate: (t: any) => {
            if (!t.tileId || !t.boundAttendeeId) return;
            setTiles((prev) => ({
              ...prev,
              [t.tileId]: { tileId: t.tileId, attendeeId: t.boundAttendeeId, local: !!t.localTile, content: !!t.isContent },
            }));
          },
          videoTileWasRemoved: (tileId: number) =>
            setTiles((prev) => {
              const next = { ...prev };
              delete next[tileId];
              return next;
            }),
        });
        av.addContentShareObserver({
          contentShareDidStart: () => setSharing(true),
          contentShareDidStop: () => setSharing(false),
        });

        av.realtimeSubscribeToAttendeeIdPresence((id: string, present: boolean, ext?: string) => {
          if (id.includes("#content")) return;
          if (!present) {
            setPeople((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
            return;
          }
          const { name, role } = decodeExternalUserId(ext);
          setPeople((prev) => ({ ...prev, [id]: prev[id] ?? { attendeeId: id, name, role, muted: true, speaking: false } }));
          // Chime for real arrivals only — not for the people already here when we connected.
          if (
            join.joinSound && !soundsOffRef.current && id !== join.attendee.AttendeeId &&
            joinedAt.current && Date.now() - joinedAt.current > 4_000
          ) playMeetSound("join");
          av.realtimeSubscribeToVolumeIndicator(id, (aid: string, volume: number | null, muted: boolean | null) => {
            setPeople((prev) => {
              const p = prev[aid];
              if (!p) return prev;
              const nm = muted ?? p.muted;
              const sp = volume === null ? p.speaking : volume > 0.15 && !nm;
              if (nm === p.muted && sp === p.speaking) return prev;
              return { ...prev, [aid]: { ...p, muted: nm, speaking: sp } };
            });
          });
        });
        av.realtimeSubscribeToMuteAndUnmuteLocalAudio((muted: boolean) => setMicOn(!muted));

        if (!viewer) {
          try {
            micStream.current = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            if (cancelled) return stopStreams();
            await av.startAudioInput(micStream.current);
            setHasMic(true);
          } catch {
            toast.error("Your microphone is blocked. Allow it in your browser to talk — you can still listen.");
          }
        }
        if (audioRef.current) await av.bindAudioElement(audioRef.current);
        if (cancelled) return;
        av.start();
        if (!viewer) {
          if (!startMic) av.realtimeMuteLocalAudio();
          else setMicOn(true);
          if (startCam) await cameraOn(av);
        }
        setTimeout(() => {
          if (!cancelled && audioRef.current?.paused) setNeedsSoundTap(true);
        }, 2500);
      } catch (err) {
        console.error("[meet] start failed", err);
        if (!cancelled) setStatus("failed");
      }
    })();

    return () => {
      cancelled = true;
      try { av?.stopContentShare(); } catch { /* not sharing */ }
      try { av?.stop(); } catch { /* already stopped */ }
      stopStreams();
      avRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.attendee.AttendeeId]);

  async function cameraOn(av = avRef.current) {
    if (!av) return;
    try {
      camStream.current = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } },
      });
      await av.startVideoInput(camStream.current);
      av.startLocalVideoTile();
      setCamOn(true);
    } catch {
      toast.error("Your camera is blocked or in use by another app.");
    }
  }

  async function toggleMic() {
    const av = avRef.current;
    if (!av) return;
    if (!hasMic) {
      try {
        micStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        await av.startAudioInput(micStream.current);
        setHasMic(true);
        av.realtimeUnmuteLocalAudio();
      } catch {
        toast.error("Your microphone is still blocked. Allow it in your browser's address bar.");
      }
      return;
    }
    if (micOn) av.realtimeMuteLocalAudio();
    else av.realtimeUnmuteLocalAudio();
  }

  async function toggleCam() {
    const av = avRef.current;
    if (!av || busy) return;
    setBusy(true);
    try {
      if (camOn) {
        av.stopLocalVideoTile();
        await av.stopVideoInput();
        camStream.current?.getTracks().forEach((t) => t.stop());
        camStream.current = null;
        setCamOn(false);
      } else {
        await cameraOn();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleShare() {
    const av = avRef.current;
    if (!av) return;
    if (sharing) {
      av.stopContentShare();
      return;
    }
    try {
      await av.startContentShareFromScreenCapture();
    } catch {
      /* user cancelled the picker */
    }
  }

  function leave() {
    leaveOnce();
    try { avRef.current?.stopContentShare(); } catch { /* noop */ }
    try { avRef.current?.stop(); } catch { /* noop */ }
    setStatus("left");
  }

  const tileList = Object.values(tiles);
  const contentTile = tileList.find((t) => t.content);
  const cameraByAttendee = useMemo(() => {
    const m = new Map<string, Tile>();
    for (const t of tileList) if (!t.content) m.set(t.attendeeId, t);
    return m;
  }, [tiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const everyone = Object.values(people);
  const speakers = everyone
    .filter((p) => p.role !== "viewer")
    .sort((a, b) => (a.attendeeId === selfId ? -1 : b.attendeeId === selfId ? 1 : a.name.localeCompare(b.name)));
  const viewerCount = everyone.filter((p) => p.role === "viewer").length;

  if (status === "ended" || status === "left" || status === "replaced" || status === "failed") {
    const msg = {
      ended: "The host ended this meeting for everyone.",
      left: "You left the meeting.",
      replaced: "You joined this meeting from another tab or device, so this one was disconnected.",
      failed: "The connection to the meeting dropped.",
    }[status];
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md w-full border border-border bg-card rounded-sm p-8 text-center space-y-4">
          <h1 className="text-xl font-bold">{msg}</h1>
          <Button onClick={onExit}>Back to the meeting page</Button>
        </div>
      </div>
    );
  }

  const gridCols =
    speakers.length <= 1 ? "grid-cols-1" : speakers.length <= 4 ? "grid-cols-2" : speakers.length <= 9 ? "grid-cols-2 md:grid-cols-3" : "grid-cols-3 md:grid-cols-4";

  return (
    <div className="h-dvh flex flex-col bg-background">
      <audio ref={audioRef} autoPlay className="hidden" />
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border">
        <div className="min-w-0">
          <div className="font-mono text-[11px] text-primary">[ MEET ]{viewer ? " · VIEW ONLY" : ""}</div>
          <h1 className="font-bold truncate">{join.title}</h1>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{speakers.length}</span>
          <span className="inline-flex items-center gap-1"><Eye className="h-3.5 w-3.5" />{viewerCount}</span>
          {join.joinSound && (
            <button
              type="button" onClick={toggleSounds} className="inline-flex items-center hover:text-foreground"
              aria-label={soundsOff ? "Turn join sounds on" : "Turn join sounds off"} title={soundsOff ? "Join sounds off" : "Join sounds on"}
            >
              {soundsOff ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
            </button>
          )}
          {status === "connecting" && <span className="text-primary">connecting…</span>}
        </div>
      </div>

      {needsSoundTap && (
        <button
          onClick={() => { audioRef.current?.play().then(() => setNeedsSoundTap(false)).catch(() => {}); }}
          className="mx-4 mt-3 flex items-center justify-center gap-2 rounded-sm bg-primary px-4 py-3 font-mono text-sm font-bold text-primary-foreground"
        >
          <Volume2 className="h-4 w-4" /> Tap to turn on sound
        </button>
      )}

      <div className={cn("flex-1 min-h-0 p-3 gap-3", contentTile ? "flex flex-col lg:flex-row" : "flex")}>
        {contentTile && (
          <div className="flex-1 min-h-0 rounded-sm border border-primary/60 bg-card overflow-hidden relative">
            <VideoEl av={avRef.current} tileId={contentTile.tileId} contain />
            <div className="absolute left-2 top-2 rounded-sm bg-background/80 px-2 py-0.5 font-mono text-[11px]">
              {people[contentTile.attendeeId.split("#")[0]]?.name ?? "Someone"} is sharing
            </div>
          </div>
        )}
        <div
          className={cn(
            contentTile
              ? "flex lg:flex-col gap-3 overflow-auto lg:w-64 shrink-0 max-h-40 lg:max-h-none"
              : cn("grid flex-1 gap-3 auto-rows-fr content-center", gridCols),
          )}
        >
          {speakers.map((p) => {
            const tile = cameraByAttendee.get(p.attendeeId);
            const isSelf = p.attendeeId === selfId;
            return (
              <div
                key={p.attendeeId}
                className={cn(
                  "relative rounded-sm bg-card border overflow-hidden aspect-video min-w-40",
                  p.speaking ? "border-primary ring-2 ring-primary" : "border-border",
                )}
              >
                {tile ? (
                  <VideoEl av={avRef.current} tileId={tile.tileId} mirror={isSelf} />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="h-16 w-16 rounded-full bg-secondary flex items-center justify-center text-2xl font-bold">
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                  </div>
                )}
                <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-sm bg-background/80 px-1.5 py-0.5 font-mono text-[11px]">
                  {(isSelf ? !micOn : p.muted) && <MicOff className="h-3 w-3 text-destructive" />}
                  <span className="truncate max-w-32">{p.name}{isSelf ? " (you)" : ""}{p.role === "host" ? " · host" : ""}</span>
                </div>
              </div>
            );
          })}
          {speakers.length === 0 && status === "live" && (
            <div className="col-span-full text-center text-muted-foreground font-mono text-sm">
              Waiting for people to join…
            </div>
          )}
        </div>
      </div>

      {join.role === "host" && join.roomId && <InMeetingHostBar roomId={join.roomId} />}

      <div className="flex items-center justify-center gap-2 border-t border-border px-4 py-3">
        {!viewer && (
          <>
            <Button variant={micOn ? "secondary" : "destructive"} size="lg" className="px-4" onClick={toggleMic} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>
              {micOn ? <Mic /> : <MicOff />}<span className="hidden sm:inline">{micOn ? "Mute" : "Unmute"}</span>
            </Button>
            <Button variant={camOn ? "secondary" : "outline"} size="lg" className="px-4" onClick={toggleCam} disabled={busy} aria-label={camOn ? "Turn camera off" : "Turn camera on"}>
              {camOn ? <Video /> : <VideoOff />}<span className="hidden sm:inline">{camOn ? "Camera off" : "Camera on"}</span>
            </Button>
            {canShare && (
              <Button variant={sharing ? "default" : "outline"} size="lg" className="px-4" onClick={toggleShare} aria-label={sharing ? "Stop sharing screen" : "Share screen"}>
                {sharing ? <MonitorX /> : <MonitorUp />}<span className="hidden sm:inline">{sharing ? "Stop sharing" : "Share screen"}</span>
              </Button>
            )}
          </>
        )}
        <Button variant="destructive" size="lg" className="px-4" onClick={leave} aria-label="Leave meeting">
          <PhoneOff /><span className="hidden sm:inline">Leave</span>
        </Button>
      </div>
    </div>
  );
}

function VideoEl({ av, tileId, mirror, contain }: { av: any; tileId: number; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!av || !ref.current) return;
    av.bindVideoElement(tileId, ref.current);
    return () => {
      try { av.unbindVideoElement(tileId, false); } catch { /* tile already gone */ }
    };
  }, [av, tileId]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cn("absolute inset-0 h-full w-full bg-background", contain ? "object-contain" : "object-cover", mirror && "-scale-x-100")}
    />
  );
}
