// Frees a meeting seat when someone leaves (button or closing the tab via sendBeacon),
// so the host stops paying for it. Requires the signed leave token issued at join.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  meetingId: z.string().uuid(),
  attendeeId: z.string().uuid(),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

export const Route = createFileRoute("/api/public/meet/leave")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.MEETING_LEAVE_SECRET;
        if (!secret) return new Response(null, { status: 503 });
        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(JSON.parse((await request.text()).slice(0, 2000)));
        } catch {
          return new Response(null, { status: 400 });
        }
        const { verifyLeaveToken } = await import("@/lib/meeting-leave");
        if (!(await verifyLeaveToken(secret, parsed.meetingId, parsed.attendeeId, parsed.token))) {
          return new Response(null, { status: 403 });
        }
        const chime = await import("@/lib/aws-chime.server");
        await chime.deleteAttendee(parsed.meetingId, parsed.attendeeId).catch(() => {});
        return new Response(null, { status: 204 });
      },
    },
  },
});
