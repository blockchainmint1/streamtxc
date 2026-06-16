// Telegram bot webhook. Handles /start <code> for wallet pairing and lets
// users disconnect with /stop. We do NOT echo arbitrary messages — this bot
// only handles its own commands.
//
// Security: Telegram includes our secret_token in the
// X-Telegram-Bot-Api-Secret-Token header. We verify it before reading the
// body. The secret is derived from TELEGRAM_API_KEY so a single secret rotation
// flows through (matches the pattern in the Telegram knowledge doc).

import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

function deriveSecret(apiKey: string) {
  return createHash("sha256")
    .update(`telegram-webhook:${apiKey}`)
    .digest("base64url");
}

function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

async function reply(chatId: number, text: string) {
  const apiKey = process.env.TELEGRAM_API_KEY;
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!apiKey || !lovableKey) return;
  try {
    await fetch(`${GATEWAY_URL}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": apiKey,
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.warn("[telegram] reply failed", err);
  }
}

export const Route = createFileRoute("/api/public/hooks/telegram")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.TELEGRAM_API_KEY;
        if (!apiKey) {
          return new Response("Telegram not configured", { status: 503 });
        }
        const expected = deriveSecret(apiKey);
        const actual =
          request.headers.get("x-telegram-bot-api-secret-token") ?? "";
        if (!safeEqual(actual, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import(
          "@/integrations/supabase/client.server"
        );

        let update: any;
        try {
          update = await request.json();
        } catch {
          return Response.json({ ok: true, ignored: "bad json" });
        }

        const message = update?.message ?? update?.edited_message;
        const chatId: number | undefined = message?.chat?.id;
        const text: string = (message?.text ?? "").trim();
        if (!chatId || !text) return Response.json({ ok: true });

        const fromUsername: string | undefined = message?.from?.username;

        // /start <CODE>  — pair this chat to a wallet
        const startMatch = text.match(/^\/start(?:@\S+)?\s+(\S+)/);
        if (startMatch || text === "/start") {
          const code = startMatch?.[1]?.toUpperCase();
          if (!code) {
            await reply(
              chatId,
              "👋 streamTXC alerts bot.\n\nOpen <b>Manage → Notifications</b> on streamtxc.com to get a pairing code, then send <code>/start CODE</code> here.",
            );
            return Response.json({ ok: true });
          }
          const { data: row, error } = await (supabaseAdmin as any)
            .from("wallet_notification_prefs")
            .select("wallet, telegram_pairing_expires_at")
            .eq("telegram_pairing_code", code)
            .maybeSingle();
          if (error || !row) {
            await reply(
              chatId,
              "❌ That pairing code doesn't match anything. Generate a new one in Manage → Notifications.",
            );
            return Response.json({ ok: true });
          }
          if (
            row.telegram_pairing_expires_at &&
            new Date(row.telegram_pairing_expires_at).getTime() < Date.now()
          ) {
            await reply(
              chatId,
              "⌛ That code has expired. Generate a fresh one and try again.",
            );
            return Response.json({ ok: true });
          }
          await (supabaseAdmin as any)
            .from("wallet_notification_prefs")
            .update({
              telegram_chat_id: chatId,
              telegram_username: fromUsername ?? null,
              telegram_pairing_code: null,
              telegram_pairing_expires_at: null,
            })
            .eq("wallet", row.wallet);
          await reply(
            chatId,
            `✅ Paired with wallet <code>${row.wallet}</code>.\n\nYou'll get a heads-up before any of your videos expire. Send <code>/stop</code> here to unsubscribe.`,
          );
          return Response.json({ ok: true, paired: row.wallet });
        }

        if (text === "/stop" || text === "/unsubscribe") {
          const { data: row } = await (supabaseAdmin as any)
            .from("wallet_notification_prefs")
            .select("wallet")
            .eq("telegram_chat_id", chatId)
            .maybeSingle();
          if (!row) {
            await reply(chatId, "You're not paired with any wallet.");
            return Response.json({ ok: true });
          }
          await (supabaseAdmin as any)
            .from("wallet_notification_prefs")
            .update({ telegram_chat_id: null, telegram_username: null })
            .eq("wallet", row.wallet);
          await reply(chatId, "👋 Unsubscribed. Re-pair anytime from Manage → Notifications.");
          return Response.json({ ok: true, unpaired: row.wallet });
        }

        if (text === "/help" || text === "/about") {
          await reply(
            chatId,
            "streamTXC alerts bot.\n\n• <code>/start CODE</code> — pair with a wallet (get the code from Manage → Notifications)\n• <code>/stop</code> — unsubscribe",
          );
          return Response.json({ ok: true });
        }

        return Response.json({ ok: true });
      },
    },
  },
});