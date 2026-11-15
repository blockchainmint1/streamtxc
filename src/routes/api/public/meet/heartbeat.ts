// "I'm still connected" check-in from a meeting tab. Billing counts only seats
// that check in, so seats that were grabbed but never used cost the host nothing.
// Requires the signed seat token issued at join (other attendees can't keep a seat alive).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  meetingId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  attendeeId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  token: z.string().regex(/^[0-9a-f]{64}$/),
});

export const Route = createFileRoute("/api/public/meet/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { leaveSecret, verifyLeaveToken } = await import("@/lib/meeting-leave");
        let secret: string;
        try {
          secret = await leaveSecret();
        } catch {
          return new Response(null, { status: 503 });
        }
        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(JSON.parse((await request.text()).slice(0, 2000)));
        } catch {
          return new Response(null, { status: 400 });
        }
        if (!(await verifyLeaveToken(secret, parsed.meetingId, parsed.attendeeId, parsed.token))) {
          return new Response(null, { status: 403 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data } = await (supabaseAdmin as any)
          .from("meeting_seats")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("attendee_id", parsed.attendeeId)
          .eq("meeting_id", parsed.meetingId)
          .is("left_at", null)
          .select("id")
          .maybeSingle();
        // 410 = this seat was removed (left, timed out or the meeting closed).
        return new Response(null, { status: data ? 204 : 410 });
      },
    },
  },
});
