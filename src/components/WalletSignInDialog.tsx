import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useServerFn } from "@tanstack/react-start";
import { Copy, RefreshCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import {
  requestWalletLogin,
  completeWalletLogin,
} from "@/lib/wallet-auth.functions";
import { useWallet, isSignableOwnershipTxcAddress } from "@/lib/wallet";
import { WALLET_POLL_INTERVAL_MS } from "@/lib/wallet-auth-shared";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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

export function WalletSignInDialog({ onClose }: { onClose: () => void }) {
  const { completeLogin } = useWallet();

  // ---- QR flow ----------------------------------------------------------
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

  // ---- Manual (paste-signature) flow ------------------------------------
  const requestLogin = useServerFn(requestWalletLogin);
  const completeLoginFn = useServerFn(completeWalletLogin);
  const [addr, setAddr] = useState("");
  const [step, setStep] = useState<"address" | "sign">("address");
  const [challengeToken, setChallengeToken] = useState("");
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);

  function normalizeSignatureInput(value: string) {
    return value.replace(/\s+/g, "");
  }

  async function handleRequestChallenge() {
    const trimmed = addr.trim();
    if (!isSignableOwnershipTxcAddress(trimmed)) {
      toast.error(
        "Use a legacy TXC address starting with T (segwit txc1… can't sign messages yet)",
      );
      return;
    }
    setBusy(true);
    try {
      const res = await requestLogin({ data: { wallet: trimmed } });
      setMessage(res.message);
      setChallengeToken(res.challengeToken);
      setStep("sign");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start login");
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteLogin() {
    const normalizedSignature = normalizeSignatureInput(signature);
    if (!normalizedSignature) {
      toast.error("Paste the signature your wallet produced");
      return;
    }
    setBusy(true);
    try {
      const res = await completeLoginFn({
        data: { challengeToken, signature: normalizedSignature },
      });
      completeLogin({
        address: res.wallet,
        token: res.token,
        expiresAt: res.expiresAt,
      });
      toast.success("Signed in");
      onClose();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not verify signature",
      );
    } finally {
      setBusy(false);
    }
  }

  const mmss = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="font-mono text-sm">
          [ SIGN IN WITH TXC WALLET ]
        </DialogTitle>
        <DialogDescription>
          Prove you control your wallet by signing a one-time challenge. No
          transaction, no fees.
        </DialogDescription>
      </DialogHeader>

      <Tabs defaultValue="qr">
        <TabsList className="grid w-full grid-cols-2 font-mono text-xs">
          <TabsTrigger value="qr">scan QR</TabsTrigger>
          <TabsTrigger value="manual">paste signature</TabsTrigger>
        </TabsList>

        {/* ---------------- QR ---------------- */}
        <TabsContent value="qr" className="pt-4">
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
                  {qr.kind === "expired"
                    ? "This code expired."
                    : qr.message}
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
        </TabsContent>

        {/* ------------- Manual ------------- */}
        <TabsContent value="manual" className="pt-4">
          {step === "address" ? (
            <div className="space-y-2">
              <Label className="font-mono text-xs">TXC ADDRESS</Label>
              <Input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="T…"
                className="font-mono"
              />
              <p className="font-mono text-xs text-muted-foreground">
                Must be a legacy T… address. Segwit txc1… can't sign messages
                yet.
              </p>
              <div className="flex justify-end pt-2">
                <Button
                  onClick={handleRequestChallenge}
                  className="font-mono"
                  disabled={busy}
                >
                  {busy ? "…" : "next"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between">
                  <Label className="font-mono text-xs">
                    1. SIGN THIS MESSAGE
                  </Label>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(message);
                      toast.success("Message copied");
                    }}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                  >
                    <Copy className="h-3 w-3" />
                    copy
                  </button>
                </div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-muted/40 p-2 font-mono text-[11px]">
                  {message}
                </pre>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  In TXC Core: <em>File → Sign Message</em>, choose{" "}
                  <span className="text-primary">{addr}</span>, paste the text
                  above, click Sign.
                </p>
              </div>
              <div>
                <Label className="font-mono text-xs">2. PASTE SIGNATURE</Label>
                <Textarea
                  value={signature}
                  onChange={(e) =>
                    setSignature(normalizeSignatureInput(e.target.value))
                  }
                  placeholder="H… (base64)"
                  className="h-20 font-mono text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  variant="ghost"
                  onClick={() => setStep("address")}
                  className="font-mono"
                  disabled={busy}
                >
                  back
                </Button>
                <Button
                  onClick={handleCompleteLogin}
                  className="font-mono"
                  disabled={busy}
                >
                  {busy ? "verifying…" : "sign in"}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} className="font-mono">
          cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
