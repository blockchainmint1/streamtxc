import { Link } from "@tanstack/react-router";
import { Play, Coins, ExternalLink, Wallet, Copy } from "lucide-react";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useWallet, shortWalletId, isSignableOwnershipTxcAddress } from "@/lib/wallet";
import {
  requestWalletLogin,
  completeWalletLogin,
} from "@/lib/wallet-auth.functions";
import { getWalletBalance } from "@/lib/wallet-balance.functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { LiveBadge } from "@/components/LiveBadge";

export function Header() {
  const { address, completeLogin, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState("");
  const [step, setStep] = useState<"address" | "sign">("address");
  const [challengeToken, setChallengeToken] = useState("");
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);

  const requestLogin = useServerFn(requestWalletLogin);
  const completeLoginFn = useServerFn(completeWalletLogin);
  const fetchBalance = useServerFn(getWalletBalance);

  const balanceQuery = useQuery({
    queryKey: ["wallet-balance", address],
    queryFn: () => fetchBalance({ data: { wallet: address! } }),
    enabled: !!address,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const balance = balanceQuery.data?.balance ?? null;
  const balanceLabel =
    balance !== null
      ? `${balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} TXC`
      : balanceQuery.isLoading
        ? "…"
        : null;

  function normalizeSignatureInput(value: string) {
    return value.replace(/\s+/g, "");
  }

  function resetDialog() {
    setAddr("");
    setStep("address");
    setChallengeToken("");
    setMessage("");
    setSignature("");
    setBusy(false);
  }

  async function handleRequestChallenge() {
    const trimmed = addr.trim();
    if (!isSignableOwnershipTxcAddress(trimmed)) {
      toast.error("Use a legacy TXC address starting with T (segwit txc1… can't sign messages yet)");
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
      completeLogin({ address: res.wallet, token: res.token, expiresAt: res.expiresAt });
      toast.success("Signed in");
      setOpen(false);
      resetDialog();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not verify signature");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2 group">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-sm"
            style={{ background: "var(--gradient-primary)" }}
          >
            <Play className="h-4 w-4 fill-background text-background" />
          </div>
          <span className="font-mono text-sm font-bold tracking-tight">
            stream<span className="uppercase">TXC</span>
          </span>
        </Link>

        <nav className="ml-auto flex items-center gap-2 text-sm font-mono">
          <LiveBadge />
          <Link
            to="/about"
            className="px-3 py-1.5 hover:text-primary transition-colors"
            activeProps={{ className: "px-3 py-1.5 text-primary" }}
          >
            about
          </Link>
          <Link
            to="/manifesto"
            className="px-3 py-1.5 hover:text-primary transition-colors"
            activeProps={{ className: "px-3 py-1.5 text-primary" }}
          >
            manifesto
          </Link>
          <Link
            to="/upload"
            className="px-3 py-1.5 hover:text-primary transition-colors"
            activeProps={{ className: "px-3 py-1.5 text-primary" }}
          >
            upload
          </Link>
          {address ? (
            <Link
              to="/manage"
              className="px-3 py-1.5 hover:text-primary transition-colors"
              activeProps={{ className: "px-3 py-1.5 text-primary" }}
              title={`${address}${balance !== null ? ` · ${balance} TXC` : ""}`}
            >
              manage [<span className="text-primary">{shortWalletId(address)}</span>
              {balanceLabel && (
                <>
                  {" · "}
                  <span className="text-primary/80">{balanceLabel}</span>
                </>
              )}
              ]
            </Link>
          ) : (
            <Link
              to="/manage"
              className="px-3 py-1.5 hover:text-primary transition-colors"
              activeProps={{ className: "px-3 py-1.5 text-primary" }}
            >
              manage
            </Link>
          )}
          {address ? (
            <button
              onClick={() => {
                disconnect();
                toast("Wallet disconnected");
              }}
              className="px-2 py-1.5 text-muted-foreground hover:text-destructive transition-colors text-xs"
              title="Disconnect wallet"
            >
              ×
            </button>
          ) : (
            <Dialog
              open={open}
              onOpenChange={(v) => {
                setOpen(v);
                if (!v) resetDialog();
              }}
            >
              <DialogTrigger asChild>
                <button className="ml-1 inline-flex items-center gap-1.5 rounded-sm border border-border bg-background px-3 py-1.5 hover:border-primary hover:text-primary transition-colors">
                  <Wallet className="h-3.5 w-3.5" />
                  sign in
                </button>
              </DialogTrigger>
              <WalletSignInDialog
                onClose={() => {
                  setOpen(false);
                  resetDialog();
                }}
              />
            </Dialog>
          )}
          <a
            href="https://swap.texitcoin.org"
            target="_blank"
            rel="noreferrer"
            className="ml-1 inline-flex items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/10 px-3 py-1.5 text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
          >
            <Coins className="h-3.5 w-3.5" />
            get TXC
            <ExternalLink className="h-3 w-3 opacity-70" />
          </a>
        </nav>
      </div>
    </header>
  );
}