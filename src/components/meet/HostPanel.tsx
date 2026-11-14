import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Bell, Check, Pencil, PhoneOff, Plus, Radio, RefreshCw, Square, Trash2, UserCheck, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { publicOrigin } from "@/lib/site-origin";
import { playMeetSound } from "@/lib/meet-sound";
import {
  createMeetingRoom, decideJoinRequest, deleteMeetingRoom, endMeeting, listJoinRequests, listMyMeetingRooms,
  startMeetingBroadcast, stopMeetingBroadcast, updateMeetingRoom,
} from "@/lib/meetings.functions";

export const MY_ROOMS_KEY = ["my-meeting-rooms"] as const;

export function useMyMeetingRooms(enabled = true) {
  const fetchRooms = useServerFn(listMyMeetingRooms);
  return useQuery({ queryKey: MY_ROOMS_KEY, queryFn: () => fetchRooms(), enabled, refetchInterval: 10_000, retry: false });
}

type RoomsData = Awaited<ReturnType<typeof listMyMeetingRooms>>;
type RoomData = RoomsData["rooms"][number];
type Billing = RoomsData["billing"];

function useRunner() {
  const qc = useQueryClient();
  const [working, setWorking] = useState<string | null>(null);
  async function run(label: string, fn: () => Promise<unknown>, ok?: string) {
    setWorking(label);
    try {
      await fn();
      if (ok) toast.success(ok);
      await qc.invalidateQueries({ queryKey: MY_ROOMS_KEY });
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      return false;
    } finally {
      setWorking(null);
    }
  }
  return { working, run };
}

/** Full /meet page: price, every room the host has, and a form for a new one. */
export function MeetingRoomsManager() {
  const rooms = useMyMeetingRooms();
  if (rooms.isLoading) return <div className="font-mono text-sm text-muted-foreground">loading your rooms…</div>;
  if (rooms.error || !rooms.data) {
    return (
      <div className="border border-border bg-card rounded-sm p-4 text-sm text-muted-foreground">
        {rooms.error instanceof Error ? rooms.error.message : "Could not load your meeting rooms."}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PriceBox billing={rooms.data.billing} />
      {rooms.data.rooms.map((r) => <RoomCard key={r.id} room={r} canDelete={rooms.data.rooms.length > 1} />)}
      <NewRoomForm />
    </div>
  );
}

function NewRoomForm() {
  const create = useServerFn(createMeetingRoom);
  const { working, run } = useRunner();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus /> New meeting room
      </Button>
    );
  }
  return (
    <form
      className="border border-border bg-card rounded-sm p-4 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run("create", () => create({ data: { title, purpose } }), "Meeting room created with its own links.");
        if (ok) { setTitle(""); setPurpose(""); setOpen(false); }
      }}
    >
      <div className="font-medium">New meeting room</div>
      <label className="block space-y-1">
        <span className="text-sm">Name</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="e.g. Weekly Sales Meeting" required autoFocus />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">Purpose (optional — guests see this)</span>
        <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} placeholder="e.g. Mondays 9am — pipeline review" />
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={!!working || !title.trim()}>Create room</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

function RoomCard({ room: r, canDelete }: { room: RoomData; canDelete: boolean }) {
  const update = useServerFn(updateMeetingRoom);
  const del = useServerFn(deleteMeetingRoom);
  const end = useServerFn(endMeeting);
  const { working, run } = useRunner();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(r.title);
  const [purpose, setPurpose] = useState(r.purpose);
  const origin = publicOrigin();
  const approvals = r.approveTeam || r.approveViewers;

  const setting = (patch: Partial<{ joinSound: boolean; approveTeam: boolean; approveViewers: boolean }>) =>
    run("setting", () => update({ data: { roomId: r.id, ...patch } }));

  return (
    <section className="border border-border bg-card/40 rounded-sm p-4 space-y-4" aria-label={r.title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {editing ? (
          <form
            className="flex-1 space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run("edit", () => update({ data: { roomId: r.id, title, purpose } }), "Saved.")) setEditing(false);
            }}
          >
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required aria-label="Meeting name" />
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} placeholder="Purpose (optional)" aria-label="Meeting purpose" />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!!working || !title.trim()}><Check /> Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setTitle(r.title); setPurpose(r.purpose); }}>Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold flex items-center gap-2">
              {r.title}
              <button type="button" onClick={() => setEditing(true)} className="text-muted-foreground hover:text-foreground" aria-label="Rename meeting">
                <Pencil className="h-4 w-4" />
              </button>
            </h2>
            {r.purpose && <p className="text-sm text-muted-foreground">{r.purpose}</p>}
            <p className="font-mono text-xs text-muted-foreground mt-1">
              {r.live ? "● open right now" : "○ nobody's in — it opens when the first person joins"}
              {r.broadcasting && " · on the live stream"}
            </p>
          </div>
        )}
        <Button asChild>
          <Link to="/meet/$code" params={{ code: r.joinCode }}>
            <Video /> {r.live ? "Join" : "Start"}
          </Link>
        </Button>
      </div>

      <LinkRow label="Team link — people can talk, use camera and share screen" url={`${origin}/meet/${r.joinCode}`} />
      <LinkRow label="View-only link — people can watch and listen, but can't be seen or heard" url={`${origin}/meet/${r.viewCode}`} />

      <div className="border border-border bg-card rounded-sm p-3 space-y-3">
        <div className="text-sm font-medium">Settings</div>
        <SettingRow
          label="Play a sound when someone joins"
          hint="Everyone in the meeting hears a soft chime. You also hear a knock when someone is waiting."
          checked={r.joinSound} disabled={!!working} onChange={(v) => setting({ joinSound: v })}
        />
        <SettingRow
          label="I approve people on the team link"
          hint="Off: anyone with the link walks right in. On: they wait until you let them in."
          checked={r.approveTeam} disabled={!!working} onChange={(v) => setting({ approveTeam: v })}
        />
        <SettingRow
          label="I approve people on the view-only link"
          hint="Off: watchers get in automatically."
          checked={r.approveViewers} disabled={!!working} onChange={(v) => setting({ approveViewers: v })}
        />
      </div>

      {(approvals || r.waitingCount > 0) && <WaitingList roomId={r.id} sound={r.joinSound} />}

      <div className="flex flex-wrap gap-2">
        <BroadcastButton room={r} />
        <Button
          variant="ghost" size="sm" disabled={!!working}
          onClick={() => {
            if (confirm("Make new links for this room? Its old team and view-only links will stop working.")) {
              void run("rotate", () => update({ data: { roomId: r.id, rotateLinks: true } }), "New links made. Send them to your team.");
            }
          }}
        >
          <RefreshCw /> Make new links
        </Button>
        {r.live && (
          <Button variant="ghost" size="sm" disabled={!!working} onClick={() => { if (confirm("End this meeting for everyone?")) void run("end", () => end({ data: { roomId: r.id } }), "Meeting ended for everyone."); }}>
            <PhoneOff /> End for everyone
          </Button>
        )}
        {canDelete && (
          <Button
            variant="ghost" size="sm" disabled={!!working} className="text-destructive"
            onClick={() => { if (confirm(`Delete "${r.title}"? Its links stop working right away.`)) void run("del", () => del({ data: { roomId: r.id } }), "Meeting room deleted."); }}
          >
            <Trash2 /> Delete room
          </Button>
        )}
      </div>
    </section>
  );
}

function SettingRow({ label, hint, checked, disabled, onChange }: {
  label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer">
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}

function BroadcastButton({ room: r }: { room: RoomData }) {
  const startBc = useServerFn(startMeetingBroadcast);
  const stopBc = useServerFn(stopMeetingBroadcast);
  const { working, run } = useRunner();
  return r.broadcasting ? (
    <Button variant="outline" size="sm" disabled={!!working} onClick={() => run("bc", () => stopBc({ data: { roomId: r.id } }), "Stopped sending to the live stream.")}>
      <Square /> Stop live stream
    </Button>
  ) : (
    <Button variant="outline" size="sm" disabled={!!working || !r.live} onClick={() => run("bc", () => startBc({ data: { roomId: r.id } }), "Sending the meeting to your live stream — it shows on /live in about a minute.")}>
      <Radio /> Send to live stream
    </Button>
  );
}

/** People waiting to be let in. Knocks once for each new arrival when sounds are on. */
export function WaitingList({ roomId, sound, compact = false }: { roomId: string; sound: boolean; compact?: boolean }) {
  const fetchList = useServerFn(listJoinRequests);
  const decide = useServerFn(decideJoinRequest);
  const qc = useQueryClient();
  const key = ["meeting-waiting", roomId];
  const list = useQuery({ queryKey: key, queryFn: () => fetchList({ data: { roomId } }), refetchInterval: 3_000, retry: false });
  const seen = useRef<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!list.data) return;
    const ids = list.data.map((w) => w.id);
    if (seen.current === null) { seen.current = new Set(ids); return; }
    const fresh = ids.filter((id) => !seen.current!.has(id));
    fresh.forEach((id) => seen.current!.add(id));
    if (fresh.length && sound) playMeetSound("knock");
  }, [list.data, sound]);

  async function act(ids: string[], admit: boolean) {
    setBusy(true);
    try {
      await decide({ data: { roomId, requestIds: ids, admit } });
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: MY_ROOMS_KEY });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const waiting = list.data ?? [];
  if (compact && waiting.length === 0) return null;
  return (
    <div className={compact ? "border-t border-border px-4 py-2 space-y-2" : "border border-primary/50 bg-card rounded-sm p-3 space-y-2"}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium inline-flex items-center gap-2">
          <Bell className="h-4 w-4 text-primary" />
          {waiting.length ? `${waiting.length} waiting to get in` : "Nobody's waiting"}
        </div>
        {waiting.length > 1 && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(waiting.map((w) => w.id), true)}>
            <UserCheck /> Let everyone in
          </Button>
        )}
      </div>
      {waiting.map((w) => (
        <div key={w.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">
            {w.name} <span className="font-mono text-xs text-muted-foreground">· {w.role === "viewer" ? "view-only" : "team"}</span>
          </span>
          <span className="flex gap-1 shrink-0">
            <Button size="sm" disabled={busy} onClick={() => act([w.id], true)}><Check /> Let in</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act([w.id], false)} aria-label={`Turn away ${w.name}`}><X /></Button>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Slim host bar shown inside the meeting screen. */
export function InMeetingHostBar({ roomId }: { roomId: string }) {
  const rooms = useMyMeetingRooms();
  const end = useServerFn(endMeeting);
  const { working, run } = useRunner();
  const r = rooms.data?.rooms.find((x) => x.id === roomId);
  if (!r) return null;
  const origin = publicOrigin();
  return (
    <div>
      <WaitingList roomId={r.id} sound={r.joinSound} compact />
      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border px-4 py-2 font-mono text-xs">
        <CopyLinkButton value={`${origin}/meet/${r.joinCode}`} label="copy join link" successMessage="Join link copied" />
        <CopyLinkButton value={`${origin}/meet/${r.viewCode}`} label="copy view-only link" successMessage="View-only link copied" />
        <BroadcastButton room={r} />
        {r.broadcasting && <span className="inline-flex items-center gap-1 text-destructive"><Radio className="h-3 w-3" /> on the live stream</span>}
        <Button
          variant="ghost" size="sm" disabled={!!working}
          onClick={() => { if (confirm("End the meeting for everyone?")) void run("end", () => end({ data: { roomId: r.id } }), "Meeting ended for everyone."); }}
        >
          <PhoneOff /> End for everyone
        </Button>
      </div>
    </div>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="border border-border bg-card rounded-sm p-3">
      <div className="text-sm mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate font-mono text-xs text-primary">{url}</code>
        <CopyLinkButton value={url} />
      </div>
    </div>
  );
}

const fmt = (n: number, d = 4) => n.toLocaleString(undefined, { maximumFractionDigits: d });

function PriceBox({ billing: b }: { billing: Billing }) {
  const tenHourTxc = b.seatMinuteTxc * 10 * 60;
  if (!b.billable) {
    return (
      <div className="border border-border bg-card rounded-sm p-3 text-sm text-muted-foreground">
        Your meeting rooms are free — they aren't charged.
      </div>
    );
  }
  const low = b.balanceTxc < b.minStartTxc;
  return (
    <div className="border border-border bg-card rounded-sm p-3 text-sm space-y-1">
      <div className="font-medium">Meeting price</div>
      <div className="text-muted-foreground">
        {fmt(b.seatMinuteTxc)} TXC (${b.seatMinuteUsd.toFixed(3)}) per person, per minute — view-only watchers count too.
        {" "}A 10-person, 1-hour meeting is about {fmt(tenHourTxc, 2)} TXC (${(b.seatMinuteUsd * 600).toFixed(2)}).
      </div>
      <div className="text-muted-foreground">
        "Send to live stream" adds {fmt(b.broadcastMinuteTxc, 2)} TXC (${b.broadcastMinuteUsd.toFixed(2)}) per minute.
      </div>
      <div className={low ? "text-destructive" : "text-foreground"}>
        Your balance: {fmt(b.balanceTxc)} TXC{low ? " — add TXC on the Manage page before starting." : ""}
      </div>
    </div>
  );
}
