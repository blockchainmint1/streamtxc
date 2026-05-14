import { Link } from "@tanstack/react-router";

export function Footer() {
  return (
    <footer className="border-t border-border mt-24">
      <div className="mx-auto max-w-7xl px-6 py-8 font-mono text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-4">
        <div>
          streamTXC.com — part of the{" "}
          <a
            href="https://honest.money"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors underline"
          >
            honest.money
          </a>{" "}
          ecosystem
        </div>
        <div className="flex gap-4">
          <a
            href="https://pinata.cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            pinned via pinata
          </a>
          <a
            href="https://ipfs.io"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            powered by IPFS
          </a>
          <a
            href="https://texitcoin.org"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            secured by TXC
          </a>
          <Link to="/privacy" className="hover:text-foreground transition-colors">privacy</Link>
          <Link to="/terms" className="hover:text-foreground transition-colors">terms</Link>
          <Link to="/api" className="hover:text-foreground transition-colors">api</Link>
        </div>
      </div>
    </footer>
  );
}