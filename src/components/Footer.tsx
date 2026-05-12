export function Footer() {
  return (
    <footer className="border-t border-border mt-24">
      <div className="mx-auto max-w-7xl px-6 py-8 font-mono text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-4">
        <div>
          stream.texitcoin.org — part of the honest.money ecosystem
        </div>
        <div className="flex gap-4">
          <span>pinned via pinata</span>
          <span>powered by IPFS</span>
          <span>secured by TXC</span>
        </div>
      </div>
    </footer>
  );
}