import { createFileRoute } from "@tanstack/react-router";
import { Video } from "lucide-react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MeetingRoomsManager } from "@/components/meet/HostPanel";
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
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-10 space-y-6">
        <div>
          <div className="font-mono text-xs text-primary mb-2">[ MEET ]</div>
          <h1 className="text-3xl font-bold">Team meetings</h1>
          <p className="text-muted-foreground mt-2">
            Standing video rooms for your team — one for each meeting you run. Everyone with a room's team link can talk,
            turn on their camera and share their screen. People with the view-only link can watch and listen without
            being seen or heard.
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

        {isAuthenticated && <MeetingRoomsManager />}
      </main>
      <Footer />
    </div>
  );
}
