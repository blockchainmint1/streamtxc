// Emergency admin impersonation. Gated by TXC_RPC_PASS.
//
// Usage:
//   https://stream.texitcoin.org/api/public/admin/impersonate-wallet
//     ?wallet=TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m
//     &token=<TXC_RPC_PASS>
//
// Issues a normal 7-day wallet session token and writes it into
// localStorage under the same `txc:wallet` key the app already uses, then
// bounces you to /manage. No wallet private key required.

import { createFileRoute } from "@tanstack/react-router";
import { issueSessionToken } from "@/lib/wallet-auth.server";

export const Route = createFileRoute("/api/public/admin/impersonate-wallet")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const wallet = (url.searchParams.get("wallet") ?? "").trim();
        const token = url.searchParams.get("token") ?? "";
        const next = url.searchParams.get("next") ?? "/manage";

        const adminSecret = process.env.TXC_RPC_PASS;
        if (!adminSecret || token !== adminSecret) {
          return new Response("Forbidden", { status: 403 });
        }
        if (!/^T[1-9A-HJ-NP-Za-km-z]{20,90}$/.test(wallet)) {
          return new Response("Bad wallet", { status: 400 });
        }

        const session = await issueSessionToken(wallet);
        const payload = JSON.stringify({
          address: wallet,
          token: session.token,
          expiresAt: session.expiresAt,
        });
        // Only a same-origin relative path is allowed for the redirect.
        const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/manage";

        const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Signing in…</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:ui-monospace,Menlo,monospace;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.b{max-width:480px;border:1px solid #262626;border-radius:4px;padding:32px;text-align:center}</style>
</head><body><div class="b"><p>Signing in as <code>${wallet}</code>…</p></div>
<script>
try {
  localStorage.setItem(${JSON.stringify("txc:wallet")}, ${JSON.stringify(payload)});
  window.dispatchEvent(new Event("txc:wallet-changed"));
} catch (e) {}
window.location.replace(${JSON.stringify(safeNext)});
</script></body></html>`;
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});