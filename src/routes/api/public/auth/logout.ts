// Cancels the caller's own sign-in server-side so a copied token stops
// working the moment someone clicks sign out.
import { createFileRoute } from "@tanstack/react-router";
import { readSessionClaims, revokeSession } from "@/lib/wallet-auth.server";

export const Route = createFileRoute("/api/public/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        if (auth.toLowerCase().startsWith("bearer ")) {
          // The signed token proves which session to cancel; nobody can
          // cancel someone else's without holding their token.
          const claims = await readSessionClaims(auth.slice(7).trim());
          if (claims) await revokeSession(claims.sid, claims.wallet);
        }
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      },
    },
  },
});
