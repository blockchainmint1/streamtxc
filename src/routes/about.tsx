import { createFileRoute, Link } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import {
  Hash,
  Link2,
  ShieldCheck,
  Coins,
  Upload,
  ArrowUpRight,
  Database,
  Eye,
} from "lucide-react";

export const Route = createFileRoute("/about")({
  head: () => {
    const faqs = [
      { q: "Who actually hosts my video?", a: "Pinata pins it on IPFS. Anyone else can pin the same CID too — that's the point. If we disappeared tomorrow, the CID still works on any IPFS gateway someone else is running." },
      { q: "What happens if I stop paying?", a: "After the prepaid window plus a 24h grace period, we unpin. The CID still resolves anywhere else it's pinned, and the on-chain record of it ever existing never goes away." },
      { q: "Can I delete a video?", a: "We can unpin from our infrastructure, but no one can un-publish a CID from IPFS as a whole, and the on-chain stamp is permanent. Treat upload as a permanent decision." },
      { q: "Is this censorship-resistant?", a: "More than a normal platform. We can refuse to serve content through our gateway, but we can't rewrite history, change the CID, or stop someone else from re-pinning and streaming the file." },
      { q: "Why TXC instead of just dollars?", a: "Because the chain is the receipt. Stripe can reverse a charge; an OP_RETURN can't. TXC is fast, cheap, and lets us anchor every action — uploads, comments, boosts — into a public ledger." },
    ];
    return {
      meta: [
        { title: "About — streamTXC" },
        { name: "description", content: "Why streamTXC exists: immutable CID filenames, on-chain receipts, no platform middleman. Pay-per-MB video hosting on IPFS, anchored to TXC." },
        { property: "og:title", content: "About — streamTXC" },
        { property: "og:description", content: "Immutable CID filenames, on-chain receipts, no platform middleman. Video hosting that's actually verifiable." },
        { property: "og:url", content: "https://streamtxc.com/about" },
        { property: "og:type", content: "article" },
      ],
      links: [{ rel: "canonical", href: "https://streamtxc.com/about" }],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faqs.map((f) => ({
              "@type": "Question",
              name: f.q,
              acceptedAnswer: { "@type": "Answer", text: f.a },
            })),
          }),
        },
      ],
    };
  },
  component: AboutPage,
});

function AboutPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      {/* Hero */}
      <section className="mx-auto w-full max-w-7xl px-6 pt-24 pb-16">
        <div className="font-mono text-xs text-primary mb-6">
          [ WHAT THIS IS · WHY IT EXISTS ]
        </div>
        <h1 className="text-5xl md:text-6xl font-bold tracking-tighter leading-[0.95] max-w-3xl">
          Video you{" "}
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: "var(--gradient-primary)" }}
          >
            actually own
          </span>
          .
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          streamTXC is a thin layer on top of two things that were already
          permanent: <strong className="text-foreground">IPFS</strong> for the
          file, and <strong className="text-foreground">TXC</strong> for the
          receipt. No accounts. No hidden re-encodes. No silent takedowns.
          Every video has a public address, and every payment has a public
          transaction.
        </p>
      </section>

      {/* What it is */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-16">
        <h2 className="text-2xl font-bold tracking-tight mb-6">
          What it is, in one breath
        </h2>
        <div className="border border-border rounded-sm p-6 bg-card font-mono text-sm leading-7 text-muted-foreground">
          <span className="text-foreground">upload</span> →{" "}
          <span className="text-foreground">pinned to IPFS</span> →{" "}
          <span className="text-foreground">CID assigned</span> →{" "}
          <span className="text-foreground">TXC payment stamped on-chain</span>{" "}
          → <span className="text-foreground">stream by hash, forever</span>{" "}
          (or until you stop paying).
        </div>
      </section>

      {/* Why */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-16">
        <h2 className="text-2xl font-bold tracking-tight mb-6">
          Why it's built this way
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border border border-border rounded-sm overflow-hidden">
          {[
            {
              icon: Hash,
              title: "Immutable filenames",
              body: "The CID is the file. Change a single byte and the address changes too. There's no way to silently swap content under the same URL.",
            },
            {
              icon: ShieldCheck,
              title: "On-chain receipts",
              body: "Every hosting payment, comment, and boost is an OP_RETURN on the TXC chain. Public, permanent, auditable by anyone with a block explorer.",
            },
            {
              icon: Database,
              title: "No platform middleman",
              body: "No account. No algorithm deciding who sees what. No copyright bot deleting your archive. You pay the network for storage and the network keeps it.",
            },
            {
              icon: Coins,
              title: "Pay what it costs",
              body: "$0.001 per MB per month, billed in TXC at the live spot price. Views earn the creator credits — popular videos help pay for their own pinning.",
            },
          ].map((p) => (
            <div key={p.title} className="bg-card p-6">
              <p.icon className="h-5 w-5 text-primary mb-3" />
              <h3 className="font-mono text-sm font-bold mb-2">{p.title}</h3>
              <p className="text-sm text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Flow */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-16">
        <h2 className="text-2xl font-bold tracking-tight mb-6">
          How a video flows
        </h2>
        <ol className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {[
            ["01", "Upload", "Browser sends the file straight to IPFS via a presigned URL."],
            ["02", "CID", "IPFS hashes the bytes and gives you a content address — the filename is the fingerprint."],
            ["03", "Pay", "A per-video TXC deposit address is generated. Pay the quote within 24h or the file is unpinned."],
            ["04", "Stamp", "We broadcast a TXCV1M OP_RETURN tying your CID to the payment. Now it's on-chain."],
            ["05", "Stream", "Anyone can watch, embed, or download by CID. No login. No region lock."],
          ].map(([n, t, b]) => (
            <li
              key={n}
              className="bg-card border border-border rounded-sm p-4"
            >
              <div className="font-mono text-xs text-primary mb-2">{n}</div>
              <div className="font-bold text-sm mb-1">{t}</div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {b}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* Verifiable */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-16">
        <h2 className="text-2xl font-bold tracking-tight mb-6">
          What you can verify yourself
        </h2>
        <ul className="space-y-3 font-mono text-sm">
          {[
            "The video bytes match the CID — fetch from any IPFS gateway and re-hash.",
            "The payment landed — every video links to its TXC transaction on the explorer.",
            "The CID was timestamped on-chain — the OP_RETURN is part of the block.",
            "Comments are real payments — each comment is its own on-chain transaction.",
            "Boosts are real money — boosting a comment is an on-chain TXC transfer, not a like button.",
          ].map((line) => (
            <li
              key={line}
              className="flex gap-3 border-l-2 border-primary/40 pl-4 text-muted-foreground"
            >
              <Link2 className="h-4 w-4 mt-0.5 text-primary shrink-0" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* FAQ */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-16">
        <h2 className="text-2xl font-bold tracking-tight mb-6">
          Common questions
        </h2>
        <div className="space-y-4">
          {[
            {
              q: "Who actually hosts my video?",
              a: "Pinata pins it on IPFS. Anyone else can pin the same CID too — that's the point. If we disappeared tomorrow, the CID still works on any IPFS gateway someone else is running.",
            },
            {
              q: "What happens if I stop paying?",
              a: "After the prepaid window plus a 24h grace period, we unpin. The CID still resolves anywhere else it's pinned, and the on-chain record of it ever existing never goes away.",
            },
            {
              q: "Can I delete a video?",
              a: "We can unpin from our infrastructure, but no one can un-publish a CID from IPFS as a whole, and the on-chain stamp is permanent. Treat upload as a permanent decision.",
            },
            {
              q: "Is this censorship-resistant?",
              a: "More than a normal platform. We can refuse to serve content through our gateway, but we can't rewrite history, change the CID, or stop someone else from re-pinning and streaming the file.",
            },
            {
              q: "Why TXC instead of just dollars?",
              a: "Because the chain is the receipt. Stripe can reverse a charge; an OP_RETURN can't. TXC is fast, cheap, and lets us anchor every action — uploads, comments, boosts — into a public ledger.",
            },
          ].map((f) => (
            <details
              key={f.q}
              className="group border border-border rounded-sm bg-card p-4 open:border-primary/40"
            >
              <summary className="cursor-pointer list-none font-mono text-sm font-bold flex items-center justify-between">
                {f.q}
                <span className="text-primary group-open:rotate-45 transition-transform">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-24">
        <div
          className="rounded-sm border border-primary/30 p-8 flex flex-wrap items-center justify-between gap-6"
          style={{ background: "var(--gradient-primary)" }}
        >
          <div className="text-background">
            <div className="font-mono text-xs opacity-80 mb-1">
              [ READY? ]
            </div>
            <h3 className="text-2xl font-bold">
              Put a video on-chain.
            </h3>
          </div>
          <div className="flex gap-3">
            <Link to="/upload">
              <Button size="lg" variant="secondary" className="font-mono">
                <Upload className="mr-2 h-4 w-4" /> Upload
              </Button>
            </Link>
            <Link to="/">
              <Button
                size="lg"
                variant="outline"
                className="font-mono bg-transparent border-background/40 text-background hover:bg-background hover:text-foreground"
              >
                <Eye className="mr-2 h-4 w-4" /> Browse
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}