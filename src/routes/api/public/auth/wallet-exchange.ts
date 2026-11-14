// Step 4: swap the one-time token for a normal streamTXC wallet session token.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { issueSessionToken, verifyWalletBrowserProof } from "@/lib/wallet-auth.server";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;

const bodySchema = z.object({
  id: z.string().uuid(),
  token: z.string().min(32).max(128),
  browser_proof: z.string().min(32).max(1000),
});

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/auth/wallet-exchange")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { error: "invalid json" },
            { status: 400, headers: CORS },
          );
        }
        const parsed = bodySchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "invalid payload" },
            { status: 400, headers: CORS },
          );
        }

        if (!await verifyWalletBrowserProof(parsed.data.browser_proof, parsed.data.id)) {
          return Response.json({ error: "Browser proof required" }, { status: 403, headers: { ...CORS, "cache-control": "no-store" } });
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { data: ch, error } = await supabaseAdmin
          .from("wallet_login_challenges")
          .select("id, status, one_time_token, wallet_address, expires_at")
          .eq("id", parsed.data.id)
          .single();

        if (error || !ch) {
          return Response.json(
            { error: "unknown challenge" },
            { status: 404, headers: CORS },
          );
        }
        if (
          new Date(ch.expires_at).getTime() <= Date.now() ||
          ch.status !== "signed" ||
          !ch.one_time_token ||
          !ch.wallet_address ||
          !safeEqual(ch.one_time_token, parsed.data.token)
        ) {
          return Response.json(
            { error: "challenge not ready" },
            { status: 409, headers: CORS },
          );
        }

        // Burn the token first — single use, race-guarded.
        const { data: burned, error: burnErr } = await supabaseAdmin
          .from("wallet_login_challenges")
          .update({
            status: "consumed",
            one_time_token: null,
            consumed_at: new Date().toISOString(),
          })
          .eq("id", ch.id)
          .eq("status", "signed")
          .select("id");

        if (burnErr || !burned?.length) {
          return Response.json(
            { error: "challenge already used" },
            { status: 409, headers: CORS },
          );
        }

        const session = await issueSessionToken(ch.wallet_address, request.headers.get("user-agent"));
        return Response.json(
          {
            wallet: ch.wallet_address,
            token: session.token,
            expiresAt: session.expiresAt,
          },
          { headers: { ...CORS, "cache-control": "no-store" } },
        );
      },
    },
  },
});
