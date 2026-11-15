import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireWalletSession, optionalWalletSession } from "./wallet-auth.functions";

import { ADMIN_WALLET } from "./admin";

const SubmitSchema = z.object({
  name: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().max(255).optional().nullable(),
  telegram: z.string().trim().max(120).optional().nullable(),
  details: z.string().trim().min(1, "details required").max(5000),
  attachment_name: z.string().max(255).optional().nullable(),
  attachment_type: z.string().max(120).optional().nullable(),
  attachment_data_url: z.string().max(3_500_000).optional().nullable(), // ~2.5MB base64
  page_url: z.string().max(500).optional().nullable(),
  user_agent: z.string().max(500).optional().nullable(),
  reporter_wallet: z.string().max(120).optional().nullable(),
});

export const submitBugReport = createServerFn({ method: "POST" })
  .middleware([optionalWalletSession])
  .inputValidator((input: unknown) => SubmitSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("bug_reports").insert({
      name: data.name || null,
      email: data.email || null,
      telegram: data.telegram || null,
      details: data.details,
      attachment_name: data.attachment_name || null,
      attachment_type: data.attachment_type || null,
      attachment_data_url: data.attachment_data_url || null,
      page_url: data.page_url || null,
      user_agent: data.user_agent || null,
      // Only a signed-in wallet is recorded — never a wallet the browser claims.
      reporter_wallet: context.wallet ?? null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listBugReports = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    // Session-verified wallet from HMAC-signed token — cannot be spoofed.
    if (context.wallet !== ADMIN_WALLET) {
      throw new Error("Forbidden");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("bug_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });