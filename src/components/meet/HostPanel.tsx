import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Radio, RefreshCw, Square, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { publicOrigin } from "@/lib/site-origin";
import {
  endMyMeeting, getMyMeetingRoom, startMeetingBroadcast, stopMeetingBroadcast, updateMyMeetingRoom,
} from "@/lib/meetings.functions";

export const MY_ROOM_KEY = ["my-meeting-room"] as const;

export function useMyMeetingRoom(enabled = true) {
  const fetchRoom = useServerFn(getMyMeetingRoom);
  return useQuery({ queryKey: MY_ROOM_KEY, queryFn: () => fetchRoom(), enabled, refetchInterval: 15_000, retry: false });
}

/** Host controls: share links, send to the AWS live stream, end for all. */
export function HostPanel({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const room = useMyMeetingRoom();
  const update = useServerFn(updateMyMeetingRoom);
  const end = useServerFn(endMyMeeting);
  const startBc = useServerFn(startMeetingBroadcast);
  const stopBc = useServerFn(stopMeetingBroadcast);
  const [working, setWorking] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>, ok?: string) {
    setWorking(label);
    try {
      await fn();
      if (ok) toast.success(ok);
      await qc.invalidateQueries({ queryKey: MY_ROOM_KEY });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setWorking(null);
    }
  }

  if (room.isLoading) return compact ? null : <div className="font-mono text-sm text-muted-foreground">loading your room…</div>;
  if (room.error || !room.data) {
    return compact ? null : (
      <div className="border border-border bg-card rounded-sm p-4 text-sm text-muted-foreground">
        {room.error instanceof Error ? room.error.message : "Could not load your meeting room."}
      </div>
    );
  }
  const r = room.data;
  const origin = publicOrigin();
  const joinUrl = `${origin}/meet/${r.joinCode}`;
  const viewUrl = `${origin}/meet/${r.viewCode}`;

  const broadcastBtn = r.broadcasting ? (
    <Button variant="outline" size="sm" disabled={!!working} onClick={() => run("bc", () => stopBc(), "Stopped sending to the live stream.")}>
      <Square /> Stop live stream
    </Button>
  ) : (
    <Button variant="outline" size="sm" disabled={!!working || !r.live} onClick={() => run("bc", () => startBc(), "Sending the meeting to your live stream — it shows on /live in about a minute.")}>
      <Radio /> Send to live stream
    </Button>
  );

  if (compact) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border px-4 py-2 font-mono text-xs">
        <CopyLinkButton value={joinUrl} label="copy join link" successMessage="Join link copied" />
        <CopyLinkButton value={viewUrl} label="copy view-only link" successMessage="View-only link copied" />
        {broadcastBtn}
        {r.broadcasting && <span className="inline-flex items-center gap-1 text-destructive"><Radio className="h-3 w-3" /> on the live stream</span>}
        <Button
          variant="ghost" size="sm" disabled={!!working}
          onClick={() => { if (confirm("End the meeting for everyone?")) void run("end", () => end(), "Meeting ended for everyone."); }}
        >
          <PhoneOff /> End for everyone
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <LinkRow label="Team link — people can talk, use camera and share screen" url={joinUrl} />
      <LinkRow label="View-only link — people can watch and listen, but can't be seen or heard" url={viewUrl} />
      <div className="flex flex-wrap gap-2">
        {broadcastBtn}
        <Button
          variant="ghost" size="sm" disabled={!!working}
          onClick={() => {
            if (confirm("Make new links? The old team and view-only links will stop working.")) {
              void run("rotate", () => update({ data: { rotateLinks: true } }), "New links made. Send them to your team.");
            }
          }}
        >
          <RefreshCw /> Make new links
        </Button>
        {r.live && (
          <Button variant="ghost" size="sm" disabled={!!working} onClick={() => { if (confirm("End the meeting for everyone?")) void run("end", () => end(), "Meeting ended for everyone."); }}>
            <PhoneOff /> End for everyone
          </Button>
        )}
      </div>
      <PriceBox billing={r.billing} />
      <p className="font-mono text-xs text-muted-foreground">
        {r.live ? "● The meeting is open right now." : "○ Nobody's in the meeting. It opens when the first person joins."}
        {" "}"Send to live stream" works while the meeting is open and your live stream light on the Manage page is green.
      </p>
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

type Billing = {
  billable: boolean; balanceTxc: number; txcUsd: number;
  seatMinuteUsd: number; broadcastMinuteUsd: number;
  seatMinuteTxc: number; broadcastMinuteTxc: number; minStartTxc: number;
};

const fmt = (n: number, d = 4) => n.toLocaleString(undefined, { maximumFractionDigits: d });

function PriceBox({ billing: b }: { billing: Billing }) {
  const tenHourTxc = b.seatMinuteTxc * 10 * 60;
  if (!b.billable) {
    return (
      <div className="border border-border bg-card rounded-sm p-3 text-sm text-muted-foreground">
        Your team room is free — it isn't charged.
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
