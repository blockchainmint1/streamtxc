// Server functions for wallet notification preferences. All mutations are
// gated by the wallet-session middleware; the verified wallet on context is
// the source of truth (never trust input).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireWalletSession } from "./wallet-auth.functions";
import { emailSendDecision } from "./security-limits";

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
  .middleware([requireWalletSession])
  .handler(async ({ context }) => {
    // Wallet is the session-verified value on context — never trusted input.
    // We also project only the fields the UI needs: sensitive columns
    // (email_verify_token, telegram_chat_id numeric value, telegram_pairing_code,
    // telegram_pairing_expires_at) never leave the server.
    const { data: row, error } = await (supabaseAdmin as any)
      .from(TABLE)
      .select(
        "wallet, email, email_verified_at, telegram_chat_id, telegram_username, notify_expiry",
      )
      .eq("wallet", context.wallet)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return null;
    const r = row as {
      wallet: string;
      email: string | null;
      email_verified_at: string | null;
      telegram_chat_id: number | null;
      telegram_username: string | null;
      notify_expiry: boolean;
    };
    return {
      wallet: r.wallet,
      email: r.email,
      email_verified_at: r.email_verified_at,
      // Expose only a boolean "connected" indicator; never the chat id itself.
      telegram_chat_id: r.telegram_chat_id != null ? 1 : null,
      telegram_username: r.telegram_username,
      notify_expiry: r.notify_expiry,
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
    // Limit how often one wallet can trigger verification emails so nobody
    // can use us to flood someone's inbox.
    const { data: prev } = await (supabaseAdmin as any)
      .from(TABLE)
      .select("email_verify_last_sent_at, email_verify_window_start, email_verify_send_count")
      .eq("wallet", wallet)
      .maybeSingle();
    const decision = emailSendDecision(
      {
        lastSentAt: prev?.email_verify_last_sent_at ?? null,
        windowStart: prev?.email_verify_window_start ?? null,
        count: prev?.email_verify_send_count ?? 0,
      },
      Date.now(),
    );
    if (!decision.ok) {
      const mins = Math.ceil(decision.retryInSec / 60);
      throw new Error(
        decision.retryInSec <= 60
          ? `Please wait ${decision.retryInSec} seconds before sending another verification email.`
          : `You've sent the most verification emails allowed for today. Try again in about ${mins >= 60 ? `${Math.ceil(mins / 60)} hours` : `${mins} minutes`}.`,
      );
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
        email_verify_last_sent_at: decision.next.lastSentAt,
        email_verify_window_start: decision.next.windowStart,
        email_verify_send_count: decision.next.count,
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
    // The link only ever goes to the inbox — never back to the browser —
    // so nobody can "verify" an address they don't control.
    return {
      ok: true,
      email: data.email,
      sent: send.ok,
      skipped: send.skipped,
      error: send.ok ? undefined : "We couldn't send the email right now. Try again in a few minutes.",
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