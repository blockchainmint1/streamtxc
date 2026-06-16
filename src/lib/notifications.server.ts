// Notification delivery helpers — Telegram (via connector gateway) and email
// (Lovable Emails via the scaffolded /lovable/email/transactional/send route).
//
// Both functions are best-effort: they swallow errors and return a status so
// the caller (cron, etc.) can record whether the alert went out without
// blowing up the loop.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GATEWAY_URL = "https://connector-gateway.lovable.dev";

export type NotifyChannel = "telegram" | "email";

export interface DeliveryResult {
  channel: NotifyChannel;
  ok: boolean;
  error?: string;
  skipped?: string;
}

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
): Promise<DeliveryResult> {
  const apiKey = process.env.TELEGRAM_API_KEY;
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!apiKey || !lovableKey) {
    return {
      channel: "telegram",
      ok: false,
      skipped: "Telegram connector not linked",
    };
  }
  try {
    const res = await fetch(`${GATEWAY_URL}/telegram/sendMessage`, {
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
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        channel: "telegram",
        ok: false,
        error: `${res.status}: ${body.slice(0, 300)}`,
      };
    }
    return { channel: "telegram", ok: true };
  } catch (err) {
    return {
      channel: "telegram",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send an app email via the scaffolded Lovable Emails route. Templates live
 * in src/lib/email-templates/ and are registered in registry.ts. If the email
 * infrastructure hasn't been set up yet, this returns a "skipped" result so
 * cron keeps running.
 */
export async function sendAppEmail(args: {
  templateName: string;
  recipientEmail: string;
  templateData?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<DeliveryResult> {
  const baseUrl =
    process.env.APP_PUBLIC_URL ??
    "https://project--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app";
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!lovableKey) {
    return { channel: "email", ok: false, skipped: "LOVABLE_API_KEY missing" };
  }
  try {
    const res = await fetch(`${baseUrl}/lovable/email/transactional/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
      },
      body: JSON.stringify({
        templateName: args.templateName,
        recipientEmail: args.recipientEmail,
        templateData: args.templateData ?? {},
        idempotencyKey: args.idempotencyKey,
      }),
    });
    if (res.status === 404) {
      return {
        channel: "email",
        ok: false,
        skipped: "Email infrastructure not yet set up",
      };
    }
    if (!res.ok) {
      const body = await res.text();
      return {
        channel: "email",
        ok: false,
        error: `${res.status}: ${body.slice(0, 300)}`,
      };
    }
    return { channel: "email", ok: true };
  } catch (err) {
    return {
      channel: "email",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface WalletPrefs {
  wallet: string;
  email: string | null;
  email_verified_at: string | null;
  telegram_chat_id: number | null;
  notify_expiry: boolean;
}

export async function loadPrefs(wallet: string): Promise<WalletPrefs | null> {
  const { data, error } = await (supabaseAdmin as any)
    .from("wallet_notification_prefs")
    .select(
      "wallet, email, email_verified_at, telegram_chat_id, notify_expiry",
    )
    .eq("wallet", wallet)
    .maybeSingle();
  if (error) {
    console.warn("[notifications] loadPrefs failed", error.message);
    return null;
  }
  return (data as WalletPrefs | null) ?? null;
}

/**
 * Fan-out an alert to whichever channels the wallet has set up + verified.
 * Returns one DeliveryResult per channel attempted. If the wallet has no
 * prefs row, returns an empty array.
 */
export async function deliverAlert(args: {
  wallet: string;
  telegramText: string;
  email: {
    templateName: string;
    templateData?: Record<string, unknown>;
    idempotencyKey?: string;
  };
}): Promise<DeliveryResult[]> {
  const prefs = await loadPrefs(args.wallet);
  if (!prefs || !prefs.notify_expiry) return [];

  const results: DeliveryResult[] = [];
  if (prefs.telegram_chat_id) {
    results.push(
      await sendTelegramMessage(prefs.telegram_chat_id, args.telegramText),
    );
  }
  if (prefs.email && prefs.email_verified_at) {
    results.push(
      await sendAppEmail({
        ...args.email,
        recipientEmail: prefs.email,
      }),
    );
  }
  return results;
}