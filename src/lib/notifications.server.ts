// Notification delivery helpers — Telegram (via connector gateway) and email
// (Amazon SES).
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

/** Send an app email through Amazon SES from the verified streamtxc.com domain. */
export async function sendAppEmail(args: {
  templateName: string;
  recipientEmail: string;
  templateData?: Record<string, unknown>;
  idempotencyKey?: string;
}): Promise<DeliveryResult> {
  const id = process.env.AWS_SES_ACCESS_KEY_ID;
  const secret = process.env.AWS_SES_SECRET_ACCESS_KEY;
  const region = process.env.AWS_SES_REGION || "us-east-1";
  if (!id || !secret) return { channel: "email", ok: false, skipped: "Amazon email keys missing" };
  const { renderAppEmail } = await import("./app-email-content");
  const msg = renderAppEmail(args.templateName, args.templateData ?? {});
  if (!msg) return { channel: "email", ok: false, error: `unknown email ${args.templateName}` };
  try {
    const { AwsClient } = await import("aws4fetch");
    const aws = new AwsClient({ accessKeyId: id, secretAccessKey: secret, region, service: "ses" });
    const res = await aws.fetch(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        FromEmailAddress: process.env.EMAIL_FROM || "streamTXC <no-reply@streamtxc.com>",
        Destination: { ToAddresses: [args.recipientEmail] },
        Content: { Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: { Html: { Data: msg.html, Charset: "UTF-8" }, Text: { Data: msg.text, Charset: "UTF-8" } },
        } },
      }),
    });
    if (!res.ok) return { channel: "email", ok: false, error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { channel: "email", ok: true };
  } catch (err) {
    return { channel: "email", ok: false, error: err instanceof Error ? err.message : String(err) };
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