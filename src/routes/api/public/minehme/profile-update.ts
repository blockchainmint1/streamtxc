// honest.money pushes member changes here (honest.money/api "Profile changes").
import { createFileRoute } from "@tanstack/react-router";
import { HME_SITE, safeEqual, hmeProfileUpdateSchema } from "@/lib/hme-protocol";

export const Route = createFileRoute("/api/public/minehme/profile-update")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.HME_ECOSYSTEM;
        if (!secret) return Response.json({ error: "not configured" }, { status: 503 });
        const bearer = request.headers.get("authorization")?.replace(/^bearer\s+/i, "");
        if (request.headers.get("x-hme-site") !== HME_SITE || !safeEqual(bearer ?? "", secret)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return Response.json({ error: "invalid body" }, { status: 400 });
        }
        const parsed = hmeProfileUpdateSchema.safeParse(raw);
        if (!parsed.success) return Response.json({ error: "invalid member update" }, { status: 400 });
        const b = parsed.data;
        const updated: { status?: string; full_name?: string; email?: string } = {};
        if (b.status !== undefined) {
          updated.status = b.status;
        }
        if (typeof b.fullName === "string") updated.full_name = b.fullName.slice(0, 200);
        if (typeof b.newEmail === "string") updated.email = b.newEmail.slice(0, 320).toLowerCase();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const memberId = b.minerId.toLowerCase();
        const { data: row, error: lookupError } = await supabaseAdmin
          .from("hm_sso_links")
          .select("member_id")
          .eq("member_id", memberId)
          .maybeSingle();
        if (lookupError) return Response.json({ error: "lookup failed" }, { status: 500 });
        if (!row) return Response.json({ error: "unknown member" }, { status: 404 });
        if (Object.keys(updated).length) {
          const { error } = await supabaseAdmin.from("hm_sso_links").update(updated).eq("member_id", memberId);
          if (error) return Response.json({ error: "update failed" }, { status: 500 });
        }
        return Response.json({ ok: true, minerId: memberId, updated });
      },
    },
  },
});
