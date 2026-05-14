import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import {
  Copy,
  Check,
  ExternalLink,
  Terminal,
  Zap,
  ShieldCheck,
  Film,
  Code2,
  Hash,
  KeyRound,
  Anchor,
  Fingerprint,
  BookOpen,
} from "lucide-react";

export const Route = createFileRoute("/api")({
  head: () => ({
    meta: [
      { title: "Public API — streamTXC" },
      {
        name: "description",
        content:
          "Free, no-key public API for streamTXC: stream IPFS-pinned videos, embed players, verify TXC signatures, and check node health.",
      },
      { property: "og:title", content: "Public API — streamTXC" },
      {
        property: "og:description",
        content:
          "Free, no-key public API for streamTXC: stream, embed, verify TXC signatures, and check node health.",
      },
    ],
  }),
  component: ApiDocsPage,
});

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      aria-label="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="relative bg-card border border-border rounded-sm">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          shell
        </span>
        <CopyBtn text={children} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre">
        {children}
      </pre>
    </div>
  );
}

function Method({ m }: { m: "GET" | "POST" }) {
  const cls =
    m === "GET"
      ? "border-primary/40 text-primary"
      : "border-amber-500/40 text-amber-500";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 border ${cls} font-mono text-[10px] tracking-wider rounded-sm`}
    >
      {m}
    </span>
  );
}

function Endpoint({
  method,
  path,
  title,
  icon,
  children,
}: {
  method: "GET" | "POST";
  path: string;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border rounded-sm bg-card/30 p-5 space-y-3">
      <div className="flex items-start gap-3">
        <div className="text-primary mt-0.5">{icon}</div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-base">{title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Method m={method} />
            <code className="font-mono text-xs text-muted-foreground break-all">
              {path}
            </code>
          </div>
        </div>
      </div>
      <div className="space-y-3 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

function ApiDocsPage() {
  const base = "https://streamtxc.com";
  const sampleCid =
    "bafybeigsqgnxogzyi7fdyogldjvia3juqkxnjvexampleexampleexample";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <section className="mx-auto max-w-4xl px-6 py-10 space-y-10">
        <header className="border-b border-border pb-6">
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            developers
          </p>
          <h1 className="mt-1 text-3xl md:text-4xl font-bold tracking-tight">
            [ public api ]
          </h1>
          <p className="mt-3 text-muted-foreground max-w-2xl">
            streamTXC is open infrastructure. Every video is content-addressed
            on IPFS and timestamped on the TXC chain — these endpoints let you
            stream, embed, and verify all of it from anywhere. No keys, no
            signups, no rate-limit dance. Just HTTP.
          </p>
          <div className="mt-4 flex flex-wrap gap-3 font-mono text-xs">
            <span className="px-2 py-1 border border-border rounded-sm">
              base: <span className="text-primary">{base}</span>
            </span>
            <span className="px-2 py-1 border border-border rounded-sm">
              auth: <span className="text-primary">none</span>
            </span>
            <span className="px-2 py-1 border border-border rounded-sm">
              cors: <span className="text-primary">*</span>
            </span>
          </div>
        </header>

        {/* Stream */}
        <Endpoint
          method="GET"
          path="/api/stream/{cid}"
          title="Stream a video"
          icon={<Film className="h-5 w-5" />}
        >
          <p>
            302-redirects to our dedicated Pinata gateway for the given IPFS
            CID. Supports HTTP Range requests, so it works as a drop-in{" "}
            <code className="font-mono text-foreground">&lt;video src&gt;</code>{" "}
            for any browser, native app, or video player. Each call also
            increments the on-site view counter (debounced per IP).
          </p>
          <Code>{`curl -L ${base}/api/stream/${sampleCid} -o video.mp4`}</Code>
          <p className="text-xs">
            HTML use:{" "}
            <code className="font-mono text-foreground">
              {`<video src="${base}/api/stream/{cid}" controls />`}
            </code>
          </p>
        </Endpoint>

        {/* Embed */}
        <Endpoint
          method="GET"
          path="/embed/{cid}"
          title="Embeddable player"
          icon={<Code2 className="h-5 w-5" />}
        >
          <p>
            A bare-bones streamTXC player you can drop into any page via{" "}
            <code className="font-mono text-foreground">&lt;iframe&gt;</code>.
            Optional query params:{" "}
            <code className="font-mono text-foreground">autoplay=1</code>,{" "}
            <code className="font-mono text-foreground">muted=1</code>,{" "}
            <code className="font-mono text-foreground">t=30</code> (start
            seconds).
          </p>
          <Code>{`<iframe
  src="${base}/embed/{cid}?autoplay=1&muted=1"
  width="640" height="360"
  frameborder="0"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen
></iframe>`}</Code>
        </Endpoint>

        {/* Verify message */}
        <Endpoint
          method="POST"
          path="/api/public/txc-verify-message"
          title="Verify a TXC signed message"
          icon={<ShieldCheck className="h-5 w-5" />}
        >
          <p>
            Cryptographically verifies a message signed by a TXC wallet. Useful
            if you're building wallet-gated content, comments, or proofs of
            ownership against any TXC address — not just streamTXC ones.
          </p>
          <Code>{`curl -X POST ${base}/api/public/txc-verify-message \\
  -H "content-type: application/json" \\
  -d '{
    "address":   "txc1q...",
    "signature": "H4r...==",
    "message":   "I own this wallet"
  }'

# → { "valid": true }`}</Code>
        </Endpoint>

        {/* Health */}
        <Endpoint
          method="GET"
          path="/api/public/txc-health"
          title="TXC node health"
          icon={<Zap className="h-5 w-5" />}
        >
          <p>
            Reports the live status of the TXC node powering on-chain
            timestamps: tip block height, chain info, hot-wallet balance, and
            the public top-up address. Handy for monitoring or building status
            dashboards.
          </p>
          <Code>{`curl ${base}/api/public/txc-health | jq`}</Code>
        </Endpoint>

        {/* On-chain proof note */}
        <section className="border border-primary/40 bg-primary/5 rounded-sm p-5 space-y-2">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-primary">
            <Hash className="h-4 w-4" /> on-chain proof
          </div>
          <p className="text-sm text-muted-foreground">
            Every video, comment, and boost on streamTXC has its own TXC wallet
            address. The full lifecycle — claim, payment, renewal, takedown —
            is published as on-chain transactions to that address. You can
            audit any of it directly on the public mempool explorer:
          </p>
          <Code>{`https://mempool.texitcoin.org/address/{video_wallet}`}</Code>
        </section>

        {/* Footer note */}
        <section className="space-y-3 pt-2">
          <h2 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            [ ground rules ]
          </h2>
          <ul className="text-sm text-muted-foreground space-y-2 list-none font-mono">
            <li>
              <span className="text-primary">·</span> Be reasonable. There's no
              hard rate limit, but bots that hammer the gateway will get
              throttled at the edge.
            </li>
            <li>
              <span className="text-primary">·</span> Videos that aren't paid
              for get unpinned after the grace window — CIDs survive on IPFS
              but may not be available from our gateway.
            </li>
            <li>
              <span className="text-primary">·</span> Want to upload? Use the{" "}
              <Link to="/upload" className="text-primary hover:underline">
                /upload
              </Link>{" "}
              flow in the UI — it handles wallet assignment, OP_RETURN
              stamping, and pricing in one shot.
            </li>
          </ul>
          <p className="text-xs text-muted-foreground pt-3 border-t border-border">
            <Terminal className="inline h-3 w-3 mr-1" /> Built something cool on
            top of this? Tag it on the chain — your tx will show up on the
            video's wallet history forever.{" "}
            <a
              href="https://texitcoin.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1"
            >
              learn more about TXC <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </section>
      </section>
      <Footer />
    </div>
  );
}