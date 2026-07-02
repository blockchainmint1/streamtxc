import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Bell, Mail, Send, Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  getWalletPrefs,
  setWalletEmail,
  requestTelegramPairing,
  disconnectTelegram,
  setNotifyExpiry,
  sendTestTelegram,
} from "@/lib/notifications.functions";

export function NotificationPrefs({ wallet }: { wallet: string }) {
  const qc = useQueryClient();
  const fetchPrefs = useServerFn(getWalletPrefs);
  const saveEmail = useServerFn(setWalletEmail);
  const startPairing = useServerFn(requestTelegramPairing);
  const stopTelegram = useServerFn(disconnectTelegram);
  const setExpiry = useServerFn(setNotifyExpiry);
  const sendTest = useServerFn(sendTestTelegram);

  const { data: prefs, isLoading } = useQuery({
    queryKey: ["wallet-prefs", wallet],
    queryFn: () => fetchPrefs(),
  });

  const [emailDraft, setEmailDraft] = useState<string>("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [pairing, setPairing] = useState<{
    code: string;
    expiresAt: string;
    botUsername: string;
    deepLink: string | null;
  } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);

  const currentEmail = prefs?.email ?? "";
  const emailVerified = !!prefs?.email_verified_at;
  const tgConnected = !!prefs?.telegram_chat_id;
  const expiryOn = prefs?.notify_expiry !== false;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wallet-prefs", wallet] });

  async function onSaveEmail(clear: boolean) {
    const value = clear ? null : emailDraft.trim() || currentEmail;
    if (!clear && !value) {
      toast.error("Enter an email first");
      return;
    }
    setEmailBusy(true);
    try {
      const res = await saveEmail({ data: { email: clear ? null : value! } });
      if (clear) {
        toast.success("Email removed");
      } else if (res.sent) {
        toast.success("Verification email sent — click the link in your inbox.");
      } else if (res.devLink) {
        toast.success("Saved. Email sending isn't wired up yet — use the verify link printed in the console.");
        console.info("[verify email link]", res.devLink);
      } else {
        toast.success("Email saved");
      }
      setEmailDraft("");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setEmailBusy(false);
    }
  }

  async function onStartPairing() {
    setPairBusy(true);
    try {
      const res = await startPairing();
      setPairing(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setPairBusy(false);
    }
  }

  async function onStopTelegram() {
    setPairBusy(true);
    try {
      await stopTelegram();
      setPairing(null);
      toast.success("Telegram disconnected");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setPairBusy(false);
    }
  }

  async function onSendTest() {
    try {
      await sendTest();
      toast.success("Test message sent to Telegram");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="mb-10 border border-border rounded-sm p-5">
      <div className="flex items-center gap-2 font-mono text-xs text-primary mb-4">
        <Bell className="h-3.5 w-3.5" /> [ NOTIFICATIONS ]
      </div>
      {isLoading ? (
        <div className="font-mono text-xs text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {/* Email */}
          <div className="space-y-3">
            <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Mail className="h-3 w-3" /> Email
            </div>
            {currentEmail ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono truncate">{currentEmail}</span>
                {emailVerified ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase text-primary">
                    <Check className="h-3 w-3" /> verified
                  </span>
                ) : (
                  <span className="text-[10px] font-mono uppercase text-amber-500">
                    pending
                  </span>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No email connected.</p>
            )}
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="you@example.com"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                className="font-mono text-xs h-9"
              />
              <Button
                size="sm"
                className="font-mono"
                disabled={emailBusy}
                onClick={() => onSaveEmail(false)}
              >
                {emailBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "send verify"}
              </Button>
            </div>
            {currentEmail && (
              <Button
                size="sm"
                variant="ghost"
                className="font-mono text-xs text-muted-foreground"
                disabled={emailBusy}
                onClick={() => onSaveEmail(true)}
              >
                remove email
              </Button>
            )}
          </div>

          {/* Telegram */}
          <div className="space-y-3">
            <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Send className="h-3 w-3" /> Telegram
            </div>
            {tgConnected ? (
              <>
                <div className="text-sm font-mono">
                  Paired
                  {prefs?.telegram_username && (
                    <span className="text-muted-foreground"> · @{prefs.telegram_username}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="font-mono" onClick={onSendTest}>
                    send test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="font-mono text-muted-foreground"
                    disabled={pairBusy}
                    onClick={onStopTelegram}
                  >
                    disconnect
                  </Button>
                </div>
              </>
            ) : pairing ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  DM the bot with this command (code expires in 15 min):
                </p>
                <div className="flex items-center gap-2 border border-border rounded-sm p-2 bg-secondary">
                  <code className="flex-1 font-mono text-sm">/start {pairing.code}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="font-mono"
                    onClick={() => {
                      navigator.clipboard.writeText(`/start ${pairing.code}`);
                      toast.success("Copied");
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
                {pairing.deepLink ? (
                  <a
                    href={pairing.deepLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block font-mono text-xs text-primary underline"
                  >
                    open in Telegram →
                  </a>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Bot username not configured — find your bot in Telegram and paste the
                    <code>/start</code> command above.
                  </p>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="font-mono text-xs text-muted-foreground"
                  onClick={() => setPairing(null)}
                >
                  cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="font-mono"
                disabled={pairBusy}
                onClick={onStartPairing}
              >
                {pairBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "connect telegram"}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Per-alert toggles */}
      <div className="mt-6 pt-4 border-t border-border space-y-3">
        <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Alerts
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <div>
            <div className="font-mono">Video expiring soon</div>
            <div className="text-xs text-muted-foreground">
              Heads-up 7 days before expiry, and again when we enter the 7-day pin grace.
            </div>
          </div>
          <Switch
            checked={expiryOn}
            onCheckedChange={async (v) => {
              try {
                await setExpiry({ data: { enabled: v } });
                invalidate();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              }
            }}
          />
        </label>
      </div>
    </div>
  );
}