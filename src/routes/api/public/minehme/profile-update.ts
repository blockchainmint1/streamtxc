// honest.money pushes member changes here (honest.money/api "Profile changes").
import { createFileRoute } from "@tanstack/react-router";

const STATUSES = ["active", "blocked", "ban", "oceanfront"];

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const Route = createFileRoute("/api/public/minehme/profile-update")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.HME_HMAC_SECRET;
        if (!secret) return Response.json({ error: "not configured" }, { status: 503 });
        const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "");
        const given =
          request.headers.get("x-minehme-secret") ??
          request.headers.get("x-minetxc-secret") ??
          bearer ??
          "";
        if (!safeEqual(given, secret)) return Response.json({ error: "unauthorized" }, { status: 401 });

        let b: { minerId?: unknown; status?: unknown; fullName?: unknown; newEmail?: unknown };
        try {
          b = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        if (typeof b.minerId !== "string" || !b.minerId) {
          return Response.json({ error: "minerId required" }, { status: 400 });
        }
        const updated: Record<string, string> = {};
        if (b.status !== undefined) {
          if (typeof b.status !== "string" || !STATUSES.includes(b.status)) {
            return Response.json({ error: "invalid status" }, { status: 400 });
          }
          updated.status = b.status;
        }
        if (typeof b.fullName === "string") updated.full_name = b.fullName.slice(0, 200);
        if (typeof b.newEmail === "string") updated.email = b.newEmail.slice(0, 320).toLowerCase();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const memberId = b.minerId.toLowerCase();
        const { data: row } = await supabaseAdmin
          .from("hm_sso_links")
          .select("member_id")
          .eq("member_id", memberId)
          .maybeSingle();
        if (!row) return Response.json({ error: "unknown member" }, { status: 404 });
        if (Object.keys(updated).length) {
          const { error } = await supabaseAdmin.from("hm_sso_links").update(updated).eq("member_id", memberId);
          if (error) return Response.json({ error: "update failed" }, { status: 500 });
        }
        return Response.json({ ok: true, minerId: b.minerId, updated });
      },
    },
  },
});
