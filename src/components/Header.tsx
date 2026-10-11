import { Link } from "@tanstack/react-router";
import { Play, Coins, ExternalLink, Wallet } from "lucide-react";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useWallet, shortWalletId } from "@/lib/wallet";
import { getWalletBalance } from "@/lib/wallet-balance.functions";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { WalletSignInDialog } from "@/components/WalletSignInDialog";
import { toast } from "sonner";
import { LiveBadge } from "@/components/LiveBadge";

export function Header() {
  const { address, disconnect } = useWallet();
  const [open, setOpen] = useState(false);

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

  function resetDialog() {
    // The sign-in dialog owns its own state; remount it on close.
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
                toast("Signed out");
                try { localStorage.setItem("hm:signed-out", "1"); } catch { /* ignore */ }
                window.location.href = `https://honest.money/logout?return_to=${encodeURIComponent(window.location.origin + "/")}`;
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