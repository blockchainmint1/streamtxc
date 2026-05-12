import { Link } from "@tanstack/react-router";
import { Play, Coins, ExternalLink } from "lucide-react";

export function Header() {
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
            to="/upload"
            className="px-3 py-1.5 hover:text-primary transition-colors"
            activeProps={{ className: "px-3 py-1.5 text-primary" }}
          >
            upload
          </Link>
          <Link
            to="/manage"
            className="px-3 py-1.5 hover:text-primary transition-colors"
            activeProps={{ className: "px-3 py-1.5 text-primary" }}
          >
            manage
          </Link>
          <Link
            to="/about"
            className="px-3 py-1.5 hover:text-primary transition-colors"
            activeProps={{ className: "px-3 py-1.5 text-primary" }}
          >
            about
          </Link>
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