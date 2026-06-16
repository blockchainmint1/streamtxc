// Email verification click-through. Loads the wallet row by token and
// flips `email_verified_at`. Returns a tiny HTML page so the user gets a
// nice confirmation in their browser.

import { createFileRoute } from "@tanstack/react-router";

function htmlPage(title: string, body: string, ok: boolean) {
  const color = ok ? "#16a34a" : "#dc2626";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:ui-monospace,Menlo,monospace;background:#0a0a0a;color:#e5e5e5;
    display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .box{max-width:480px;border:1px solid #262626;border-radius:4px;padding:32px;text-align:center}
  h1{color:${color};font-size:18px;margin:0 0 12px;text-transform:uppercase;letter-spacing:.1em}
  p{font-size:14px;line-height:1.6;color:#a3a3a3}
  a{color:#60a5fa}
</style></head><body><div class="box"><h1>${title}</h1>${body}</div></body></html>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export const Route = createFileRoute("/api/public/notify/verify-email")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("token");
        if (!token) {
          return htmlPage("Missing token", "<p>This verify link is malformed.</p>", false);
        }
        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );
        const { data: row } = await (supabaseAdmin as any)
          .from("wallet_notification_prefs")
          .select("wallet, email, email_verify_expires_at, email_verified_at")
          .eq("email_verify_token", token)
          .maybeSingle();
        if (!row) {
          return htmlPage(
            "Invalid link",
            "<p>This verify link doesn't match any wallet. It may have been replaced by a newer verification request.</p>",
            false,
          );
        }
        if (row.email_verified_at) {
          return htmlPage(
            "Already verified",
            `<p>${row.email} is already verified for this wallet. <a href="/manage">Back to Manage</a>.</p>`,
            true,
          );
        }
        if (
          row.email_verify_expires_at &&
          new Date(row.email_verify_expires_at).getTime() < Date.now()
        ) {
          return htmlPage(
            "Link expired",
            "<p>This verify link expired. Open Manage → Notifications and click <em>Send verification</em> again.</p>",
            false,
          );
        }
        const { error } = await (supabaseAdmin as any)
          .from("wallet_notification_prefs")
          .update({
            email_verified_at: new Date().toISOString(),
            email_verify_token: null,
            email_verify_expires_at: null,
          })
          .eq("wallet", row.wallet);
        if (error) {
          return htmlPage("Server error", `<p>${error.message}</p>`, false);
        }
        return htmlPage(
          "Verified",
          `<p>${row.email} is now verified for wallet <code>${row.wallet}</code>. You'll get expiry alerts here.</p><p><a href="/manage">Back to Manage</a></p>`,
          true,
        );
      },
    },
  },
});