// Server functions for wallet notification preferences. All mutations are
// gated by the wallet-session middleware; the verified wallet on context is
// the source of truth (never trust input).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireWalletSession } from "./wallet-auth.functions";

const TABLE = "wallet_notification_prefs";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email")
  .max(254);

function shortCode(bytes = 6): string {
  // base32-like, uppercase, no ambiguous chars
  const raw = randomBytes(bytes).toString("base64url").toUpperCase();
  return raw.replace(/[O0LI1_=-]/g, "X").slice(0, 8);
}

/**
 * Public: hand the manage page the current prefs for a wallet. No session
 * required because the prefs themselves are not sensitive (and this lets
 * the page show "no email connected" without forcing a login first).
 * Returns null if no row exists.
 */
export const getWalletPrefs = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ wallet: z.string().trim().min(8).max(120) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await (supabaseAdmin as any)
      .from(TABLE)
      .select(
        "wallet, email, email_verified_at, telegram_chat_id, telegram_username, telegram_pairing_code, telegram_pairing_expires_at, notify_expiry",
      )
      .eq("wallet", data.wallet)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return row as null | {
      wallet: string;
      email: string | null;
      email_verified_at: string | null;
      telegram_chat_id: number | null;
      telegram_username: string | null;
      telegram_pairing_code: string | null;
      telegram_pairing_expires_at: string | null;
      notify_expiry: boolean;
    };
  });

/** Save (or clear) the email address for a wallet, queuing a verify link. */
export const setWalletEmail = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z
      .object({
        email: emailSchema.nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    if (!data.email) {
      await (supabaseAdmin as any)
        .from(TABLE)
        .upsert(
          {
            wallet,
            email: null,
            email_verify_token: null,
            email_verify_expires_at: null,
            email_verified_at: null,
          },
          { onConflict: "wallet" },
        );
      return { ok: true, email: null, sent: false };
    }
    const token = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error } = await (supabaseAdmin as any).from(TABLE).upsert(
      {
        wallet,
        email: data.email,
        email_verify_token: token,
        email_verify_expires_at: expires,
        email_verified_at: null,
      },
      { onConflict: "wallet" },
    );
    if (error) throw new Error(error.message);

    const baseUrl =
      process.env.APP_PUBLIC_URL ?? "https://streamtxc.com";
    const verifyLink = `${baseUrl}/api/public/notify/verify-email?token=${token}`;
    const { sendAppEmail } = await import("./notifications.server");
    const send = await sendAppEmail({
      templateName: "wallet-verify-email",
      recipientEmail: data.email,
      templateData: { wallet, verifyLink },
      idempotencyKey: `verify-${wallet}-${token.slice(0, 8)}`,
    });
    return {
      ok: true,
      email: data.email,
      sent: send.ok,
      skipped: send.skipped,
      error: send.error,
      // Surface the link in dev/preview so the user can verify even before
      // the email-domain is fully wired up.
      devLink: send.ok ? undefined : verifyLink,
    };
  });

/**
 * Issue (or refresh) a Telegram pairing code. The user pastes this into a DM
 * with our bot as `/start <CODE>`; the webhook then binds chat_id ↔ wallet.
 */
export const requestTelegramPairing = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const wallet = context.wallet;
    const code = shortCode();
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { error } = await (supabaseAdmin as any).from(TABLE).upsert(
      {
        wallet,
        telegram_pairing_code: code,
        telegram_pairing_expires_at: expires,
      },
      { onConflict: "wallet" },
    );
    if (error) throw new Error(error.message);
    const botUsername =
      process.env.TELEGRAM_BOT_USERNAME ?? "TXC_notify_bot";
    const deepLink = botUsername
      ? `https://t.me/${botUsername}?start=${code}`
      : null;
    return { code, expiresAt: expires, botUsername, deepLink };
  });

/** Disconnect Telegram (clears chat_id and pairing). */
export const disconnectTelegram = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const wallet = context.wallet;
    const { error } = await (supabaseAdmin as any)
      .from(TABLE)
      .upsert(
        {
          wallet,
          telegram_chat_id: null,
          telegram_username: null,
          telegram_pairing_code: null,
          telegram_pairing_expires_at: null,
        },
        { onConflict: "wallet" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setNotifyExpiry = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .inputValidator((input) =>
    z.object({ enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const wallet = context.wallet;
    const { error } = await (supabaseAdmin as any)
      .from(TABLE)
      .upsert(
        { wallet, notify_expiry: data.enabled },
        { onConflict: "wallet" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Send a test telegram message — useful for "did my pairing work?". */
export const sendTestTelegram = createServerFn({ method: "POST" })
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    const wallet = context.wallet;
    const { data: row } = await (supabaseAdmin as any)
      .from(TABLE)
      .select("telegram_chat_id")
      .eq("wallet", wallet)
      .maybeSingle();
    const chatId = (row as { telegram_chat_id: number | null } | null)
      ?.telegram_chat_id;
    if (!chatId) throw new Error("Telegram is not connected for this wallet.");
    const { sendTelegramMessage } = await import("./notifications.server");
    const result = await sendTelegramMessage(
      chatId,
      `streamTXC: test message for <code>${wallet}</code>. Your alerts are wired up. ✅`,
    );
    if (!result.ok)
      throw new Error(result.error ?? result.skipped ?? "Send failed");
    return { ok: true };
  });