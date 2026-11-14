import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Eye, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { toast } from "sonner";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MeetingRoom, type JoinResult } from "@/components/meet/MeetingRoom";
import { checkJoinRequest, getMeetingInfo, joinMeeting } from "@/lib/meetings.functions";
import { useWallet } from "@/lib/wallet";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/meet/$code")({
  head: () => ({
    meta: [
      ...pageMeta("Join meeting — streamTXC", "You've been invited to a video meeting on streamTXC."),
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: JoinPage,
});

const NAME_KEY = "meet:name";

function JoinPage() {
  const { code } = Route.useParams();
  const { address } = useWallet();
  const fetchInfo = useServerFn(getMeetingInfo);
  const doJoin = useServerFn(joinMeeting);
  const doCheck = useServerFn(checkJoinRequest);
  const [waiting, setWaiting] = useState<{ requestId: string; token: string } | null>(null);
  const [denied, setDenied] = useState(false);
  const info = useQuery({
    queryKey: ["meeting-info", code, address],
    queryFn: () => fetchInfo({ data: { code } }),
    retry: false,
    refetchInterval: 20_000,
  });
  const [name, setName] = useState("");
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState<JoinResult | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    setName(window.localStorage.getItem(NAME_KEY) ?? "");
  }, []);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    window.localStorage.setItem(NAME_KEY, n);
    setJoining(true);
    setJoinError(null);
    setDenied(false);
    try {
      const res = await doJoin({ data: { code, name: n } });
      if (res.status === "waiting") setWaiting({ requestId: res.requestId, token: res.token });
      else setJoined(res as JoinResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not join the meeting.";
      setJoinError(msg);
      toast.error(msg);
    } finally {
      setJoining(false);
    }
  }

  // While waiting for the host: check in every 2 seconds (this also tells the host we're still here).
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await doCheck({ data: waiting });
        if (stop) return;
        if (res.status === "joined") { setWaiting(null); setJoined(res as JoinResult); return; }
        if (res.status === "denied") { setWaiting(null); setDenied(true); return; }
      } catch (err) {
        if (stop) return;
        setWaiting(null);
        setJoinError(err instanceof Error ? err.message : "Could not join the meeting.");
        return;
      }
      timer = setTimeout(tick, 2_000);
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [waiting, doCheck]);

  if (joined) {
    return (
      <MeetingRoom
        join={joined}
        startMic={mic}
        startCam={cam}
        onExit={() => { setJoined(null); void info.refetch(); }}
      />
    );
  }

  const d = info.data;
  const viewer = d?.found && d.role === "viewer";

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-md w-full px-6 py-12">
        {info.isLoading && <div className="font-mono text-sm text-muted-foreground">checking your link…</div>}
        {info.isError && <div className="text-sm text-destructive">Couldn't check this link. Refresh to try again.</div>}
        {d && !d.found && (
          <div className="border border-border bg-card rounded-sm p-6 space-y-3">
            <h1 className="text-xl font-bold">This meeting link doesn't work</h1>
            <p className="text-sm text-muted-foreground">The host may have made new links. Ask them for the latest one.</p>
            <Button asChild variant="outline"><Link to="/meet">About meetings</Link></Button>
          </div>
        )}
        {d?.found && waiting && (
          <div className="border border-border bg-card rounded-sm p-6 space-y-4 text-center" role="status">
            <div className="font-mono text-xs text-primary">[ WAITING ROOM ]</div>
            <h1 className="text-2xl font-bold">{d.title}</h1>
            <p className="text-sm text-muted-foreground">
              The host has been told you're here. You'll go straight in as soon as they let you in — keep this page open.
            </p>
            <div className="font-mono text-sm text-primary animate-pulse">waiting for the host…</div>
            <Button variant="ghost" onClick={() => setWaiting(null)}>Cancel</Button>
          </div>
        )}
        {d?.found && !waiting && (
          <form onSubmit={handleJoin} className="border border-border bg-card rounded-sm p-6 space-y-5">
            <div>
              <div className="font-mono text-xs text-primary mb-1">
                [ {viewer ? "VIEW ONLY" : d.role === "host" ? "YOU'RE THE HOST" : "TEAM MEETING"} ]
              </div>
              <h1 className="text-2xl font-bold">{d.title}</h1>
              {d.purpose && <p className="text-sm text-muted-foreground">{d.purpose}</p>}
              <p className="text-sm text-muted-foreground mt-1">
                {d.live
                  ? "● The meeting is open now."
                  : viewer
                    ? "○ The meeting hasn't started yet — this page checks again every 20 seconds."
                    : "○ Nobody's here yet — you'll open the room."}
              </p>
            </div>
            {viewer && (
              <p className="flex gap-2 text-sm text-muted-foreground">
                <Eye className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
                You'll watch and listen. Nobody will see or hear you.
              </p>
            )}
            <label className="block space-y-1.5">
              <span className="text-sm">Your name</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="e.g. Bobby" required autoFocus />
            </label>
            {!viewer && (
              <div className="flex gap-2">
                <Button type="button" variant={mic ? "secondary" : "outline"} onClick={() => setMic(!mic)} className="flex-1">
                  {mic ? <Mic /> : <MicOff />} {mic ? "Mic on" : "Mic off"}
                </Button>
                <Button type="button" variant={cam ? "secondary" : "outline"} onClick={() => setCam(!cam)} className="flex-1">
                  {cam ? <Video /> : <VideoOff />} {cam ? "Camera on" : "Camera off"}
                </Button>
              </div>
            )}
            {d.needsApproval && (
              <p className="text-sm text-muted-foreground">The host lets each person in. After you click join, you'll wait a moment for them.</p>
            )}
            {denied && <p role="alert" className="text-sm text-destructive">The host didn't let you in this time.</p>}
            {joinError && <p role="alert" className="text-sm text-destructive">{joinError}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={joining || !name.trim() || (viewer && !d.live && !d.needsApproval)}>
              {joining ? "Joining…" : d.needsApproval ? "Ask to join" : viewer ? "Start watching" : "Join meeting"}
            </Button>
          </form>
        )}
      </main>
      <Footer />
    </div>
  );
}
