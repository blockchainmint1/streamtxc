// Public branch-share endpoint ("hm-link-xpubs"), HME Wallet scans the QR.
// GET  ?token=…  → manifest for the wallet's consent sheet
// POST           → signed envelope with the branch-1105 xpub
// Token is single-use + short-lived; xpub accepted only when the signature
// over the server challenge verifies against the supplied identity address.

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { branchIdentityMatches } from "@/lib/audit-access-rules";
import {
  BRANCH_XPUB_PATH,
  IDENTITY_PATH,
  WALLET_LINK_TYPE,
  WALLET_LINK_VERSION,
  buildLinkMessage,
  isLikelyXpub,
} from "@/lib/wallet-branch";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const submitSchema = z.object({
  token: z.string().trim().min(8).max(64),
  identity_address: z.string().trim().regex(/^T[1-9A-HJ-NP-Za-km-z]{20,90}$/),
  xpub: z.string().trim().refine(isLikelyXpub, "Invalid extended public key"),
  path: z.string().trim().max(60).optional(),
  signature: z.string().trim().min(64).max(200),
  app_name: z.string().trim().max(60).optional(),
});

export const Route = createFileRoute("/api/public/v1/wallet-link")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),

      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token")?.trim();
        if (!token) return json({ error: "missing token" }, 400);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: row } = await supabaseAdmin
          .from("wallet_branch_requests")
          .select("token, challenge, status, expires_at")
          .eq("token", token)
          .maybeSingle();
        if (!row) return json({ error: "unknown token" }, 404);
        if (row.status !== "pending") return json({ error: `token ${row.status}` }, 409);
        if (new Date(row.expires_at).getTime() < Date.now()) return json({ error: "token expired" }, 410);
        const origin = new URL(request.url).origin;
        return json({
          type: WALLET_LINK_TYPE,
          version: WALLET_LINK_VERSION,
          app: { name: "streamTXC", domain: new URL(request.url).host, icon: "/favicon.ico" },
          purpose:
            "Share your streamTXC branch so every video you post is filed and recorded in your own wallet.",
          challenge_id: row.token,
          challenge: row.challenge,
          expires_at: row.expires_at,
          request: [{ chain: "TXC", path: BRANCH_XPUB_PATH, scope: "xpub", label: "streamTXC video branch" }],
          message_template:
            "Honest Money - Link wallet\\n\\nDomain: {domain}\\nChallenge: {challenge}\\nPath: {path}\\nXpub: {xpub}\\n\\nSigning this message shares a watch-only public key. It does NOT authorize any transaction or spend any coins.",
          signature: { scheme: "BIP-137", encoding: "base64", signing_path: IDENTITY_PATH },
          submit_url: `${origin}/api/public/v1/wallet-link`,
        });
      },

      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        const parsed = submitSchema.safeParse(body);
        if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "invalid payload" }, 400);
        const input = parsed.data;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: row } = await supabaseAdmin
          .from("wallet_branch_requests")
          .select("id, challenge, wallet, status, expires_at")
          .eq("token", input.token)
          .maybeSingle();
        if (!row) return json({ error: "unknown token" }, 404);
        if (row.status !== "pending") return json({ error: `token ${row.status}` }, 409);
        if (new Date(row.expires_at).getTime() < Date.now()) {
          await supabaseAdmin.from("wallet_branch_requests").update({ status: "expired" }).eq("id", row.id);
          return json({ error: "token expired" }, 410);
        }

        if (!branchIdentityMatches(row.wallet, input.identity_address)) {
          return json({ error: "Sign with the wallet this branch request belongs to." }, 403);
        }

        const path = input.path || BRANCH_XPUB_PATH;
        if (path !== BRANCH_XPUB_PATH) return json({ error: `streamTXC needs branch ${BRANCH_XPUB_PATH}` }, 400);

        const message = buildLinkMessage({
          domain: new URL(request.url).host,
          challenge: row.challenge,
          xpub: input.xpub,
          path,
        });
        const { verifyTxcSignature } = await import("@/lib/wallet-signature.server");
        const ok = verifyTxcSignature({ address: input.identity_address, message, signature: input.signature });
        if (!ok) {
          await supabaseAdmin
            .from("wallet_branch_requests")
            .update({ status: "failed", error: "signature did not verify" })
            .eq("id", row.id);
          return json({ error: "signature did not verify" }, 401);
        }

        try {
          const { assertDerivableXpub } = await import("@/lib/branch-xpub.server");
          assertDerivableXpub(input.xpub);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }

        // Keep the index counter if they re-share the same branch.
        const { data: existing } = await supabaseAdmin
          .from("wallet_branch_links")
          .select("xpub, next_index")
          .eq("wallet", row.wallet)
          .maybeSingle();
        await supabaseAdmin.from("wallet_branch_links").upsert({
          wallet: row.wallet,
          identity_address: input.identity_address,
          xpub: input.xpub,
          xpub_path: path,
          next_index: existing?.xpub === input.xpub ? existing.next_index : 0,
          linked_at: new Date().toISOString(),
        });
        await supabaseAdmin
          .from("wallet_branch_requests")
          .update({ status: "linked", consumed_at: new Date().toISOString() })
          .eq("id", row.id);

        return json({ ok: true, linked_to: "streamTXC", path });
      },
    },
  },
});
