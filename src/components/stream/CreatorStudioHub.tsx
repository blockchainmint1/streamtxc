import { Link } from "@tanstack/react-router";
import { Clapperboard, MonitorPlay, Radio, Users, Layers, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMyMeetingRooms } from "@/components/meet/HostPanel";
import { RestreamDestinations } from "@/components/RestreamDestinations";

/** Creator home: launch the browser studio, manage destinations, or use your own encoder. */
export function CreatorStudioHub(_props: { wallet: string }) {
  const rooms = useMyMeetingRooms();
  const list = rooms.data?.rooms ?? [];

  return (
    <div className="space-y-8">
      <section className="border border-border bg-card/40 rounded-sm p-5 space-y-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2"><Clapperboard className="h-6 w-6 text-primary" /> Studio</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Go live from your browser — nothing to install. Invite guests with a link, pick who's on stage, choose a layout and add your branding.
          </p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-3 text-sm">
          <li className="flex items-center gap-2"><Users className="h-4 w-4 text-primary" /> Guests by link</li>
          <li className="flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /> Solo, side-by-side, grid, screen share</li>
          <li className="flex items-center gap-2"><Palette className="h-4 w-4 text-primary" /> Logo, banner text, colors</li>
        </ul>

        {rooms.isLoading ? (
          <p className="text-sm text-muted-foreground font-mono">Loading your studios…</p>
        ) : rooms.isError ? (
          <p className="text-sm text-muted-foreground">Sign in with your wallet session to open a studio.</p>
        ) : list.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">You need a room to use as your studio.</p>
            <Button asChild><Link to="/manage" search={{ tab: "meetings" }}>Create a room</Link></Button>
          </div>
        ) : (
          <div className="space-y-2">
            {list.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 border border-border rounded-sm px-4 py-3">
                <div className="min-w-0">
                  <div className="font-bold truncate">{r.title}</div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {r.live ? `open · ${r.seatsNow} in` : "closed"}{r.broadcasting ? " · LIVE" : ""}
                  </div>
                </div>
                <Button asChild>
                  <Link to="/meet/$code" params={{ code: r.joinCode }} search={{ studio: true }}>
                    <MonitorPlay /> Open studio
                  </Link>
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Studio time is billed like a meeting, plus the live-broadcast rate while you're on air. Room settings and guest links live on the{" "}
              <Link to="/manage" search={{ tab: "meetings" }} className="underline">Meetings tab</Link>.
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold">Destinations</h2>
        <p className="text-sm text-muted-foreground">Send your show to YouTube, Facebook, Twitch or any RTMP server at the same time as streamTXC.</p>
        <RestreamDestinations />
      </section>

      <section className="border border-border bg-card/40 rounded-sm p-5 space-y-2">
        <h2 className="text-xl font-bold flex items-center gap-2"><Radio className="h-5 w-5 text-primary" /> Using OBS or StreamYard instead?</h2>
        <p className="text-sm text-muted-foreground">
          Gamers and power users can keep their own software. Copy your server address and stream key from the Live tab and paste them in as a custom RTMP destination.
        </p>
        <Button asChild variant="outline"><Link to="/manage" search={{ tab: "live" }}>Server address &amp; key →</Link></Button>
      </section>
    </div>
  );
}
