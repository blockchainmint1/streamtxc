import { Link } from "@tanstack/react-router";
import { Play, Coins, ExternalLink, Wallet } from "lucide-react";
import { useState } from "react";
import { useWallet, shortWalletId, isValidTxcAddress } from "@/lib/wallet";
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
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function Header() {
  const { address, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState("");

  function handleConnect() {
    const trimmed = addr.trim();
    if (!isValidTxcAddress(trimmed)) {
      toast.error("That doesn't look like a valid TXC address");
      return;
    }
    try {
      connect(trimmed);
      setAddr("");
      setOpen(false);
      toast.success("Wallet connected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
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
          <Link
            to="/about"
            className="px-3 py-1.5 hover:text-primary transition-colors"
            activeProps={{ className: "px-3 py-1.5 text-primary" }}
          >
            about
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
              title={address}
            >
              manage [<span className="text-primary">{shortWalletId(address)}</span>]
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
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <button className="ml-1 inline-flex items-center gap-1.5 rounded-sm border border-border bg-background px-3 py-1.5 hover:border-primary hover:text-primary transition-colors">
                  <Wallet className="h-3.5 w-3.5" />
                  connect wallet
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="font-mono text-sm">[ CONNECT TXC WALLET ]</DialogTitle>
                  <DialogDescription>
                    Paste your TXC address to associate uploads with it. Optional —
                    uploads work without a wallet too. To <em>prove</em> you own the
                    address (and unlock payouts), you'll sign a challenge from your
                    /manage page.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label className="font-mono text-xs">TXC ADDRESS</Label>
                  <Input
                    value={addr}
                    onChange={(e) => setAddr(e.target.value)}
                    placeholder="L… / M… / txc1…"
                    className="font-mono"
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)} className="font-mono">
                    cancel
                  </Button>
                  <Button onClick={handleConnect} className="font-mono">
                    connect
                  </Button>
                </DialogFooter>
              </DialogContent>
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