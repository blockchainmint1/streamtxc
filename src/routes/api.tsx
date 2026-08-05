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

        {/* Table of contents */}
        <nav className="border border-border rounded-sm p-5 bg-card/30">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground mb-3">
            <BookOpen className="h-3.5 w-3.5" /> [ contents ]
          </div>
          <ol className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-sm">
            <li><a className="hover:text-primary transition-colors" href="#cid">01 · the CID is the truth</a></li>
            <li><a className="hover:text-primary transition-colors" href="#chain">02 · on-chain proof &amp; OP_RETURN</a></li>
            <li><a className="hover:text-primary transition-colors" href="#login">03 · login by signing</a></li>
            <li><a className="hover:text-primary transition-colors" href="#stream">04 · stream a video</a></li>
            <li><a className="hover:text-primary transition-colors" href="#embed">05 · embed the player</a></li>
            <li><a className="hover:text-primary transition-colors" href="#verify">06 · verify a TXC signature</a></li>
            <li><a className="hover:text-primary transition-colors" href="#health">07 · TXC node health</a></li>
            <li><a className="hover:text-primary transition-colors" href="#mempool">08 · audit on mempool</a></li>
          </ol>
        </nav>

        {/* CID importance */}
        <section id="cid" className="scroll-mt-24 space-y-3">
          <div className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-bold tracking-tight">
              01 · the CID <span className="text-muted-foreground">is the truth</span>
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Every video on streamTXC is identified by its{" "}
            <span className="text-foreground font-mono">IPFS CID</span> — a
            cryptographic hash of the file's bytes. Same bytes →
            same CID. Different bytes → different CID. Always.
          </p>
          <p className="text-sm text-muted-foreground">
            That makes the CID the only identifier that actually matters.
            Our database row, our gateway URL, our chain timestamp, and any
            third-party IPFS pinner anywhere in the world all reference the
            exact same content via the exact same string. If we ever go dark,
            you can re-pin any CID elsewhere and the link still resolves.
          </p>
          <Code>{`# A CID looks like this:
bafybeigsqgnxogzyi7fdyogldjvia3juqkxnjv...

# Anyone can fetch it from any IPFS gateway:
curl -L https://ipfs.io/ipfs/{cid} -o video.mp4
curl -L https://ipfs.honest.money/ipfs/{cid} -o video.mp4
curl -L ${base}/api/stream/{cid}    -o video.mp4`}</Code>
          <p className="text-xs text-muted-foreground">
            Treat the CID as the canonical link to a video — pass it around,
            stamp it on chain, embed it, archive it. Our{" "}
            <code className="font-mono text-foreground">/v/{`{cid}`}</code>{" "}
            page is just a friendly wrapper around it.
          </p>
        </section>

        {/* On-chain proof */}
        <section id="chain" className="scroll-mt-24 space-y-3">
          <div className="flex items-center gap-2">
            <Anchor className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-bold tracking-tight">
              02 · on-chain proof <span className="text-muted-foreground">&amp; OP_RETURN</span>
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            When a video is claimed, paid for, renewed, taken down, or DMCA'd,
            we broadcast a tiny TXC transaction whose{" "}
            <code className="font-mono text-foreground">OP_RETURN</code>{" "}
            output carries an ≤80-byte tag describing the event. Every event
            is sent <em>to</em> a per-video deposit address, so a single
            mempool address page is the entire public lifecycle of that
            video — claim, payment, renewal, takedown, the whole thing.
          </p>
          <p className="text-sm text-muted-foreground">
            Comments work the same way: the comment body is pinned to IPFS,
            then its CID is stamped against the video's wallet via
            OP_RETURN. The chain proves <em>when</em> something was said and{" "}
            <em>by which wallet</em> — IPFS proves <em>what</em> was said.
          </p>
          <Code>{`event tags broadcast in OP_RETURN

  C  claim          — first time a video lands on the network
  P  payment        — hosting payment received
  R  renewal        — hosting prepaid for another period
  T  takedown       — uploader took it down
  D  DMCA           — moderator pulled it
  M  metadata       — title/description/uploader update
  X  comment        — IPFS CID of a new comment body`}</Code>
          <p className="text-xs text-muted-foreground">
            Result: TXC proof is permanent — the timestamp does not expire
            even if our gateway goes away. Anyone can decode the OP_RETURN
            payloads against a video's deposit address and reconstruct its
            full history without trusting us.
          </p>
        </section>

        {/* Login by signing */}
        <section id="login" className="scroll-mt-24 space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-bold tracking-tight">
              03 · login <span className="text-muted-foreground">by signing</span>
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            streamTXC has no usernames or passwords. To prove you control a
            wallet, you sign a one-time challenge message with TXC Core's{" "}
            <span className="text-foreground font-mono">Sign Message</span>{" "}
            tool (or any wallet that produces a base64 message signature for
            a legacy "T…" address). We verify it server-side against the TXC
            node — no transaction, no spend, no gas.
          </p>
          <Code>{`# Step 1 — request a challenge
curl -X POST ${base}/_serverFn/requestWalletLogin \\
  -H "content-type: application/json" \\
  -d '{"data":{"wallet":"T9..."}}'

# → { "message": "streamTXC — Sign in...", "challengeToken": "eyJhbGc..." }

# Step 2 — sign \`message\` in TXC Core (File → Sign Message),
# then hand the signature + challengeToken back:

curl -X POST ${base}/_serverFn/completeWalletLogin \\
  -H "content-type: application/json" \\
  -d '{"data":{
        "challengeToken": "eyJhbGc...",
        "signature":      "H4r...=="
      }}'

# → session token (5 min challenge TTL, then verified)`}</Code>
          <p className="text-xs text-muted-foreground">
            The challenge message explicitly says{" "}
            <em>"signing this does NOT authorize any transaction or spend
            any TXC."</em>{" "}
            That's true — message signing is a pure ECDSA proof of key
            ownership. The wallet itself never moves.
          </p>
          <p className="text-xs text-muted-foreground">
            Programmatic verification of any TXC-signed message — not just
            ours — is also exposed as a one-shot endpoint, see{" "}
            <a href="#verify" className="text-primary hover:underline">
              §06
            </a>
            .
          </p>
        </section>

        {/* Stream */}
        <div id="stream" className="scroll-mt-24" />
        <Endpoint
          method="GET"
          path="/api/stream/{cid}"
          title="04 · stream a video"
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
        <div id="embed" className="scroll-mt-24" />
        <Endpoint
          method="GET"
          path="/embed/{cid}"
          title="05 · embed the player"
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
        <div id="verify" className="scroll-mt-24" />
        <Endpoint
          method="POST"
          path="/api/public/txc-verify-message"
          title="06 · verify a TXC signed message"
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
        <div id="health" className="scroll-mt-24" />
        <Endpoint
          method="GET"
          path="/api/public/txc-health"
          title="07 · TXC node health"
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
        <section id="mempool" className="scroll-mt-24 border border-primary/40 bg-primary/5 rounded-sm p-5 space-y-2">
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-primary">
            <Hash className="h-4 w-4" /> 08 · audit on mempool
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