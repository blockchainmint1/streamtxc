import { createFileRoute, Link } from "@tanstack/react-router";
import { Video } from "lucide-react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { HostPanel, useMyMeetingRoom } from "@/components/meet/HostPanel";
import { useWallet } from "@/lib/wallet";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/meet/")({
  head: () => ({
    meta: [
      ...pageMeta(
        "Team meetings — streamTXC",
        "Host your team's video meeting on streamTXC: talk, share cameras and screens, and give watchers a view-only link.",
      ),
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MeetHome,
});

function MeetHome() {
  const { isAuthenticated } = useWallet();
  const room = useMyMeetingRoom(isAuthenticated);
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-10 space-y-6">
        <div>
          <div className="font-mono text-xs text-primary mb-2">[ MEET ]</div>
          <h1 className="text-3xl font-bold">{room.data?.title ?? "Team meetings"}</h1>
          <p className="text-muted-foreground mt-2">
            A standing video room for your team. Everyone with the team link can talk, turn on their camera and share
            their screen. People with the view-only link can watch and listen without being seen or heard.
          </p>
        </div>

        {!isAuthenticated && (
          <div className="border border-border bg-card rounded-sm p-6 space-y-2">
            <Video className="h-8 w-8 text-primary" />
            <h2 className="font-bold">Got a meeting link?</h2>
            <p className="text-sm text-muted-foreground">
              Just open it — no account needed to join. Hosts: sign in with the button at the top of the page to see
              your room's links.
            </p>
          </div>
        )}

        {isAuthenticated && (
          <>
            {room.data && (
              <Button asChild size="lg">
                <Link to="/meet/$code" params={{ code: room.data.joinCode }}>
                  <Video /> {room.data.live ? "Join the meeting" : "Start the meeting"}
                </Link>
              </Button>
            )}
            <HostPanel />
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
