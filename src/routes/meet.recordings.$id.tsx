import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Copy, Download, FileText, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/wallet";
import { pageMeta } from "@/lib/page-meta";
import { clockLabel, PUBLISH_DESCRIPTION_MAX, PUBLISH_TITLE_MAX } from "@/lib/meeting-rules";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteMeetingRecording, getMeetingRecording, publishMeetingRecording, retryMeetingNotes,
} from "@/lib/meetings.functions";

export const Route = createFileRoute("/meet/recordings/$id")({
  head: () => ({
    meta: [
      ...pageMeta(
        "Meeting recording & notes — streamTXC",
        "Your private meeting recording, word-for-word transcript and AI meeting notes on streamTXC.",
      ),
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: RecordingPage,
});

function RecordingPage() {
  const { isAuthenticated } = useWallet();
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-10 space-y-6">
        <Link to="/meet" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> back to meetings
        </Link>
        {isAuthenticated ? (
          <RecordingView />
        ) : (
          <div className="border border-border bg-card rounded-sm p-6 text-sm text-muted-foreground">
            Sign in with the button at the top of the page to see this recording. Only the meeting's host can open it.
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}

type Rec = Awaited<ReturnType<typeof getMeetingRecording>>;

function RecordingView() {
  const { id } = Route.useParams();
  const fetchRec = useServerFn(getMeetingRecording);
  const publish = useServerFn(publishMeetingRecording);
  const retry = useServerFn(retryMeetingNotes);
  const del = useServerFn(deleteMeetingRecording);
  const qc = useQueryClient();
  const navigate = Route.useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const key = ["meeting-recording", id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchRec({ data: { id } }),
    retry: false,
    // Keep checking while AWS finishes the files or the video is being published.
    refetchInterval: (query) => {
      const d = query.state.data as Rec | undefined;
      if (!d) return false;
      const working = d.status === "recording" || d.status === "processing" || d.publishStatus === "transcoding" || d.publishStatus === "pinning";
      return working ? 15_000 : false;
    },
    // Playback links expire after a few hours; don't swap them mid-video.
    refetchOnWindowFocus: false,
  });

  async function act(label: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(label);
    try {
      await fn();
      if (ok) toast.success(ok);
      await qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (q.isLoading) return <div className="font-mono text-sm text-muted-foreground">loading…</div>;
  if (q.error || !q.data) {
    return (
      <div className="border border-border bg-card rounded-sm p-6 text-sm text-muted-foreground">
        {q.error instanceof Error ? q.error.message : "That recording wasn't found."}
      </div>
    );
  }
  const r = q.data;
  const started = new Date(r.startedAt);
  const mins = r.endedAt ? Math.max(1, Math.round((Date.parse(r.endedAt) - started.getTime()) / 60000)) : null;
  const canPublish = r.status === "ready" && !!r.videoUrl && (r.publishStatus === "private" || r.publishStatus === "failed");
  const transcriptText = r.transcriptText ?? "";

  function downloadTranscript() {
    const blob = new Blob([`${r.title}\n${started.toLocaleString()}\n\n${transcriptText}\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${r.title} ${started.toISOString().slice(0, 10)} transcript.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="font-mono text-xs text-primary mb-2">[ MEETING RECORDING ]</div>
        <h1 className="text-3xl font-bold">{r.title}</h1>
        <p className="text-muted-foreground mt-1">
          {started.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          {" at "}{started.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          {mins ? ` · ${mins} minutes` : ""}
          {" · "}{r.video && r.notes ? "video + notes" : r.video ? "video" : "notes"}
        </p>
      </div>

      {r.status === "recording" && (
        <Notice>● Still recording. End the recording (or the meeting) and the files will be ready a few minutes later.</Notice>
      )}
      {r.status === "processing" && (
        <Notice>Finishing up — AWS is putting the recording together. This usually takes a few minutes. This page checks again on its own.</Notice>
      )}
      {r.error && r.status !== "processing" && <Notice tone="bad">{r.error}</Notice>}

      {r.video && r.status === "ready" && (
        <section className="space-y-3" aria-label="Video">
          {r.videoUrl ? (
            <>
              <video src={r.videoUrl} controls playsInline preload="metadata" className="w-full rounded-sm border border-border bg-card aspect-video" />
              <div className="flex flex-wrap gap-2">
                {r.downloadUrl && (
                  <Button asChild variant="outline" size="sm">
                    <a href={r.downloadUrl}><Download /> Download video{r.videoBytes ? ` (${(r.videoBytes / 1024 ** 2).toFixed(0)} MB)` : ""}</a>
                  </Button>
                )}
                {canPublish && !publishing && (
                  <Button size="sm" disabled={!!busy} onClick={() => setPublishing(true)}>
                    <Send /> Publish to my channel
                  </Button>
                )}
              </div>
              {canPublish && publishing && (
                <PublishForm
                  defaultTitle={`${r.title} — ${started.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
                  defaultDescription={r.summary ?? ""}
                  busy={!!busy}
                  onCancel={() => setPublishing(false)}
                  onPublish={async (title, description) => {
                    const ok = await act("publish", () => publish({ data: { id, title, description } }), "Publishing — it shows on your channel in about 10–20 minutes.");
                    if (ok) setPublishing(false);
                  }}
                />
              )}
              <p className="text-xs text-muted-foreground">
                Private — only you can see this. The private video is kept for {r.keepDays} days; the transcript and notes are kept for good.
              </p>
            </>
          ) : (
            <Notice>
              {r.videoKept ? "The video didn't come through for this recording." : `This private video was removed after ${r.keepDays} days. The notes below are still here.`}
            </Notice>
          )}
          {(r.publishStatus === "transcoding" || r.publishStatus === "pinning") && (
            <Notice>Publishing to your channel… ({r.publishStatus === "transcoding" ? "converting the video" : "saving it to IPFS"})</Notice>
          )}
          {r.publishStatus === "published" && r.publishedCid && (
            <Notice>
              It's on your channel.{" "}
              <Link to="/v/$cid" params={{ cid: r.publishedCid }} className="text-primary underline">Watch the public video</Link>
            </Notice>
          )}
        </section>
      )}

      {r.notes && r.status === "ready" && (
        <section className="border border-border bg-card rounded-sm p-4 space-y-4" aria-label="Meeting notes">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold flex items-center gap-2"><FileText className="h-5 w-5 text-primary" /> Meeting notes</h2>
            {r.notesStatus === "failed" && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("retry", () => retry({ data: { id } }), "Notes written.")}>
                <RefreshCw /> {busy === "retry" ? "Writing…" : "Try notes again"}
              </Button>
            )}
          </div>
          {r.notesStatus === "pending" && <p className="text-sm text-muted-foreground">Writing the notes…</p>}
          {r.summary && <p className="leading-relaxed">{r.summary}</p>}
          <NoteList title="Key points" items={r.keyPoints} />
          <NoteList title="Decisions" items={r.decisions} />
          {r.actionItems.length > 0 && (
            <div>
              <h3 className="font-medium mb-1">To-do list</h3>
              <ul className="space-y-1 text-sm">
                {r.actionItems.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-primary">☐</span>
                    <span>
                      {a.task}
                      {(a.owner || a.due) && (
                        <span className="text-muted-foreground"> — {[a.owner, a.due].filter(Boolean).join(", ")}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.summary && <p className="text-xs text-muted-foreground">Written by AI from the transcript — double-check anything important.</p>}
        </section>
      )}

      {r.notes && r.status === "ready" && r.transcript.length > 0 && (
        <section className="space-y-3" aria-label="Transcript">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-bold">Transcript</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(transcriptText).then(() => toast.success("Transcript copied"))}>
                <Copy /> Copy
              </Button>
              <Button size="sm" variant="outline" onClick={downloadTranscript}><Download /> Download</Button>
            </div>
          </div>
          <ol className="border border-border bg-card rounded-sm divide-y divide-border max-h-[70vh] overflow-auto">
            {r.transcript.map((l, i) => (
              <li key={i} className="p-3 text-sm grid grid-cols-[4rem_1fr] gap-2">
                <span className="font-mono text-xs text-muted-foreground pt-0.5">{clockLabel(l.atMs)}</span>
                <span><span className="font-bold">{l.speaker}:</span> {l.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {r.status !== "recording" && (
        <Button
          variant="ghost" size="sm" className="text-destructive" disabled={!!busy}
          onClick={() => {
            if (confirm("Delete this recording, transcript and notes for good? A video already on your channel stays there.")) {
              void act("del", () => del({ data: { id } }), "Recording deleted.").then((ok) => { if (ok) void navigate({ to: "/meet" }); });
            }
          }}
        >
          <Trash2 /> Delete recording
        </Button>
      )}
    </div>
  );
}

function NoteList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="font-medium mb-1">{title}</h3>
      <ul className="list-disc pl-5 space-y-0.5 text-sm">
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone?: "bad" }) {
  return (
    <div className={tone === "bad" ? "border border-destructive/60 bg-card rounded-sm p-3 text-sm" : "border border-border bg-card rounded-sm p-3 text-sm text-muted-foreground"}>
      {children}
    </div>
  );
}

/** The host checks (and can fix) the public title and description before anything is posted. */
function PublishForm({ defaultTitle, defaultDescription, busy, onCancel, onPublish }: {
  defaultTitle: string;
  defaultDescription: string;
  busy: boolean;
  onCancel: () => void;
  onPublish: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle.slice(0, PUBLISH_TITLE_MAX));
  const [description, setDescription] = useState(defaultDescription.slice(0, PUBLISH_DESCRIPTION_MAX));
  return (
    <form
      className="border border-border bg-card rounded-sm p-4 space-y-3"
      onSubmit={(e) => { e.preventDefault(); onPublish(title, description); }}
    >
      <div className="font-medium">Publish to your channel</div>
      <p className="text-xs text-muted-foreground">
        Anyone will be able to watch it. Check the title and description first — the description starts as the AI summary, so fix anything it got wrong.
      </p>
      <label className="block space-y-1">
        <span className="text-sm">Title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={PUBLISH_TITLE_MAX} required />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">Description</span>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={PUBLISH_DESCRIPTION_MAX} rows={6} />
        <span className="block text-xs text-muted-foreground text-right">{description.length}/{PUBLISH_DESCRIPTION_MAX}</span>
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !title.trim()}><Send /> Publish</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
