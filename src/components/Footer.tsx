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
          <span>pinned via pinata</span>
          <span>powered by IPFS</span>
          <span>secured by TXC</span>
          <Link to="/privacy" className="hover:text-foreground transition-colors">privacy</Link>
        </div>
      </div>
    </footer>
  );
}