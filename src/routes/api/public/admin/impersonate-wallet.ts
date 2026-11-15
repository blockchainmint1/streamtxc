// Emergency admin sign-in as any wallet. Gated by TXC_RPC_PASS (Bobby's choice —
// no separate admin password).
//
// Usage: open https://streamtxc.com/api/public/admin/impersonate-wallet?wallet=T...
// and type the password into the box. The password is sent in the form body, never
// in the address, so it can't end up in browser history, server logs or referrers.
// The session lasts 12 hours, is labelled "emergency sign-in" and is cancelled
// by "Sign out everywhere".

import { createFileRoute } from "@tanstack/react-router";
import { issueSessionToken } from "@/lib/wallet-auth.server";
import { secretMatches } from "@/lib/admin-token";
import { escapeHtml } from "@/lib/security-limits";

const WALLET_RE = /^T[1-9A-HJ-NP-Za-km-z]{20,90}$/;
const EMERGENCY_TTL_SEC = 12 * 3600;

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

const STYLE = `body{font-family:ui-monospace,Menlo,monospace;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.b{max-width:480px;width:100%;border:1px solid #262626;border-radius:4px;padding:32px}
label{display:block;margin:12px 0 4px;font-size:13px}input{width:100%;box-sizing:border-box;padding:8px;background:#111;color:#e5e5e5;border:1px solid #333;border-radius:3px}
button{margin-top:16px;padding:10px 16px;background:#e5e5e5;color:#0a0a0a;border:0;border-radius:3px;font-weight:bold;cursor:pointer}.e{color:#f87171}`;

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/manage";
}

function formPage(wallet: string, next: string, error?: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Emergency sign-in</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head><body><div class="b">
<h1 style="font-size:18px;margin:0 0 8px">Emergency sign-in</h1>
${error ? `<p class="e">${escapeHtml(error)}</p>` : ""}
<form method="post" autocomplete="off">
<label for="wallet">Wallet</label><input id="wallet" name="wallet" value="${escapeHtml(wallet)}" required>
<label for="token">Admin password</label><input id="token" name="token" type="password" required autofocus>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Sign in</button></form></div></body></html>`;
  return new Response(html, { status: error ? 403 : 200, headers: HEADERS });
}

export const Route = createFileRoute("/api/public/admin/impersonate-wallet")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        // Old-style links that put the password in the address are refused on purpose.
        const hadToken = url.searchParams.has("token");
        return formPage(
          (url.searchParams.get("wallet") ?? "").trim(),
          safeNext(url.searchParams.get("next")),
          hadToken ? "For safety the password can't go in the link any more. Type it in the box below." : undefined,
        );
      },
      POST: async ({ request }) => {
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        const wallet = String(form.get("wallet") ?? "").trim();
        const token = String(form.get("token") ?? "");
        const next = safeNext(String(form.get("next") ?? ""));
        if (!secretMatches(token, process.env.TXC_RPC_PASS)) {
          return formPage(wallet, next, "That password isn't right.");
        }
        if (!WALLET_RE.test(wallet)) return formPage(wallet, next, "That doesn't look like a TXC wallet address.");

        const ua = `emergency sign-in · ${(request.headers.get("user-agent") ?? "").slice(0, 250)}`;
        const session = await issueSessionToken(wallet, ua, EMERGENCY_TTL_SEC);
        const payload = JSON.stringify({ address: wallet, token: session.token, expiresAt: session.expiresAt });
        // JSON inside <script>: escape "<" so no value can close the tag.
        const js = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head>
<body><div class="b"><p>Signing in as <code>${escapeHtml(wallet)}</code>…</p></div>
<script>
try {
  localStorage.setItem(${js("txc:wallet")}, ${js(payload)});
  window.dispatchEvent(new Event("txc:wallet-changed"));
} catch (e) {}
window.location.replace(${js(next)});
</script></body></html>`;
        return new Response(html, { status: 200, headers: HEADERS });
      },
    },
  },
});
