// Cron (every 2 minutes, long timeout): finishes meeting recordings once AWS
// has joined their pieces — video file, who-said-what transcript, AI notes —
// and moves "publish to channel" requests along. Guarded by x-admin-token.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/meeting-recordings-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        const { runMeetingRecordingTick } = await import("@/lib/meeting-recording.server");
        const out = await runMeetingRecordingTick(new URL(request.url).origin);
        return Response.json({ ok: true, ...out });
      },
    },
  },
});
