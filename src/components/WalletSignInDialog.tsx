import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { RefreshCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { useWallet } from "@/lib/wallet";
import { WALLET_POLL_INTERVAL_MS } from "@/lib/wallet-auth-shared";
import { publicOrigin } from "@/lib/site-origin";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Challenge {
  id: string;
  nonce: string;
  expires_at: string;
  message: string;
  deep_link: string;
  qr_data: string;
}

type QrState =
  | { kind: "loading" }
  | { kind: "waiting"; challenge: Challenge }
  | { kind: "signing"; challenge: Challenge }
  | { kind: "expired" }
  | { kind: "error"; message: string };

function openHonestMoneyPopup() {
  const returnTo = `${publicOrigin()}/sso`;
  let prompt = "";
  try {
    if (localStorage.getItem("hm:signed-out")) prompt = "&prompt=login";
  } catch { /* ignore */ }
  const url = `https://honest.money/sso-login?popup=1${prompt}&return_to=${encodeURIComponent(returnTo)}`;
  const w = 480;
  const h = 720;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  window.open(
    url,
    "hm-sso",
    `width=${w},height=${h},left=${left},top=${top},popup=1`,
  );
}

export function WalletSignInDialog({
  onClose,
  hideHonestMoney,
}: {
  onClose: () => void;
  hideHonestMoney?: boolean;
}) {
  // Default: honest.money SSO only. hideHonestMoney is set on /sso's link
  // step, where the one-time wallet QR sign-in is still needed.
  if (!hideHonestMoney) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            [ SIGN IN ]
          </DialogTitle>
          <DialogDescription>
            Sign in with your honest.money account — one click, no passwords
            here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-4">
          <Button
            className="font-mono"
            onClick={() => {
              openHonestMoneyPopup();
              onClose();
            }}
          >
            sign in with honest.money
          </Button>
          <p className="max-w-xs text-center font-mono text-xs text-muted-foreground">
            The first time, you'll link your HME Wallet once — after that,
            honest.money alone signs you in.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="font-mono">
            cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return <WalletQrSignIn onClose={onClose} />;
}

function WalletQrSignIn({ onClose }: { onClose: () => void }) {
  const { completeLogin } = useWallet();
  const [qr, setQr] = useState<QrState>({ kind: "loading" });
  const [remaining, setRemaining] = useState(0);
  const cancelled = useRef(false);

  const createChallenge = useCallback(async () => {
    setQr({ kind: "loading" });
    try {
      const res = await fetch("/api/public/auth/wallet-challenge", {
        method: "POST",
      });
      if (!res.ok) throw new Error("Could not create a sign-in code");
      const ch = (await res.json()) as Challenge;
      if (cancelled.current) return;
      setQr({ kind: "waiting", challenge: ch });
    } catch (err) {
      if (cancelled.current) return;
      setQr({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void createChallenge();
    return () => {
      cancelled.current = true;
    };
  }, [createChallenge]);

  // Countdown
  useEffect(() => {
    if (qr.kind !== "waiting" && qr.kind !== "signing") return;
    const expiresAt = new Date(qr.challenge.expires_at).getTime();
    const tick = () => {
      const ms = expiresAt - Date.now();
      if (ms <= 0) {
        setQr({ kind: "expired" });
        return;
      }
      setRemaining(Math.ceil(ms / 1000));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [qr]);

  const exchange = useCallback(
    async (challengeId: string, oneTimeToken: string) => {
      setQr((s) =>
        s.kind === "waiting" ? { kind: "signing", challenge: s.challenge } : s,
      );
      try {
        const res = await fetch("/api/public/auth/wallet-exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: challengeId, token: oneTimeToken }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Sign-in failed");
        }
        const data = (await res.json()) as {
          wallet: string;
          token: string;
          expiresAt: number;
        };
        completeLogin({
          address: data.wallet,
          token: data.token,
          expiresAt: data.expiresAt,
        });
        toast.success("Signed in");
        onClose();
      } catch (err) {
        setQr({
          kind: "error",
          message: err instanceof Error ? err.message : "Sign-in failed",
        });
      }
    },
    [completeLogin, onClose],
  );

  // Poll for the phone's signature
  const waitingId = qr.kind === "waiting" ? qr.challenge.id : null;
  useEffect(() => {
    if (!waitingId) return;
    let stopped = false;
    (async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, WALLET_POLL_INTERVAL_MS));
        if (stopped) return;
        try {
          const res = await fetch(
            `/api/public/auth/wallet-status?id=${waitingId}`,
          );
          if (!res.ok) continue;
          const data = (await res.json()) as { status: string; token?: string };
          if (data.status === "expired") {
            setQr({ kind: "expired" });
            return;
          }
          if (data.status === "signed" && data.token) {
            stopped = true;
            await exchange(waitingId, data.token);
            return;
          }
        } catch {
          // network blip — keep polling
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [waitingId, exchange]);

  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="font-mono text-sm">
          [ SIGN IN WITH TXC WALLET ]
        </DialogTitle>
        <DialogDescription>
          Scan with HME Wallet to sign in. No transaction, no fees.
        </DialogDescription>
      </DialogHeader>

      <div className="pt-2">
        <div className="flex flex-col items-center gap-3">
          {(qr.kind === "waiting" || qr.kind === "signing") && (
            <>
              <div className="rounded-sm bg-white p-3">
                <QRCodeSVG
                  value={qr.challenge.qr_data}
                  size={216}
                  level="M"
                  marginSize={1}
                />
              </div>
              <p className="text-center text-xs font-mono text-muted-foreground">
                Open <span className="text-primary">HME Wallet</span> → scan
                this code → approve the sign-in.
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {qr.kind === "signing"
                  ? "signing you in…"
                  : `waiting for your phone · expires in ${mmss}`}
              </p>
              <a
                href={qr.challenge.deep_link}
                className="inline-flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 font-mono text-xs hover:border-primary hover:text-primary sm:hidden"
              >
                <Smartphone className="h-3.5 w-3.5" />
                open HME Wallet on this phone
              </a>
            </>
          )}

          {qr.kind === "loading" && (
            <div className="flex h-[240px] items-center justify-center font-mono text-xs text-muted-foreground">
              generating code…
            </div>
          )}

          {(qr.kind === "expired" || qr.kind === "error") && (
            <div className="flex h-[240px] flex-col items-center justify-center gap-3">
              <p className="text-center font-mono text-xs text-muted-foreground">
                {qr.kind === "expired" ? "This code expired." : qr.message}
              </p>
              <Button
                variant="outline"
                className="font-mono"
                onClick={() => void createChallenge()}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                new code
              </Button>
            </div>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} className="font-mono">
          cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
