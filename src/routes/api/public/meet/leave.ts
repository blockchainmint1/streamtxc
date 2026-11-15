// Frees a meeting seat when someone leaves (button or closing the tab via sendBeacon),
// so the host stops paying for it. Requires the signed seat token issued at join.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  meetingId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  attendeeId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

export const Route = createFileRoute("/api/public/meet/leave")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { leaveSecret, verifyLeaveToken } = await import("@/lib/meeting-leave");
        let secret: string;
        try {
          secret = await leaveSecret();
        } catch {
          console.error("[meet-leave] seat key missing — seats cannot be freed");
          return new Response(null, { status: 503 });
        }
        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(JSON.parse((await request.text()).slice(0, 2000)));
        } catch (e) {
          console.warn("[meet-leave] bad body", e instanceof Error ? e.message.slice(0, 200) : e);
          return new Response(null, { status: 400 });
        }
        if (!(await verifyLeaveToken(secret, parsed.meetingId, parsed.attendeeId, parsed.token))) {
          return new Response(null, { status: 403 });
        }
        const chime = await import("@/lib/aws-chime.server");
        await chime.deleteAttendee(parsed.meetingId, parsed.attendeeId).catch(() => {});
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await (supabaseAdmin as any).from("meeting_seats").update({ left_at: new Date().toISOString() })
          .eq("attendee_id", parsed.attendeeId).eq("meeting_id", parsed.meetingId).is("left_at", null);
        return new Response(null, { status: 204 });
      },
    },
  },
});
