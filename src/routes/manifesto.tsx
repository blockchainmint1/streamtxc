import { createFileRoute, Link } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Skull, ShieldCheck, Upload, ArrowRight, Flame } from "lucide-react";

export const Route = createFileRoute("/manifesto")({
  head: () => ({
    meta: [
      { name: "twitter:card", content: "summary" },
      { property: "og:type", content: "website" },
      { title: "Manifesto — streamTXC" },
      {
        name: "description",
        content:
          "Stamp it before you post it. Why creators should prove ownership of every clip on-chain — and why free hosting is the real scam.",
      },
      { property: "og:title", content: "Stamp it before you post it." },
      {
        property: "og:description",
        content:
          "Free hosting made you the product. Proof made you replaceable. streamTXC fixes both.",
      },
    ],
  }),
  component: ManifestoPage,
});

function ManifestoPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      {/* Hero */}
      <section className="mx-auto w-full max-w-4xl px-6 pt-24 pb-12">
        <div className="font-mono text-xs text-primary mb-6">
          [ MANIFESTO · v1 ]
        </div>
        <h1 className="text-5xl md:text-7xl font-bold tracking-tighter leading-[0.95]">
          Stamp it{" "}
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: "var(--gradient-primary)" }}
          >
            before
          </span>{" "}
          you post it.
        </h1>
        <p className="mt-8 text-xl md:text-2xl text-muted-foreground leading-relaxed max-w-3xl">
          The internet has more video than it has memory. The platforms have
          more storage than they have spine. Creators have more output than
          they have proof. We're here to fix the last one — and burn the rest
          down on the way.
        </p>
      </section>

      {/* Some stuff needs to die */}
      <section className="mx-auto w-full max-w-4xl px-6 py-16 border-t border-border">
        <div className="flex items-center gap-3 mb-6">
          <Skull className="h-6 w-6 text-destructive" />
          <div className="font-mono text-xs text-destructive">
            [ SOME STUFF NEEDS TO DIE ]
          </div>
        </div>
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-6 max-w-3xl">
          "Free" hosting was never free. You were the invoice.
        </h2>
        <div className="space-y-5 text-lg text-muted-foreground leading-relaxed max-w-3xl">
          <p>
            YouTube hosts the dumbest fourteen seconds of your cousin's 2009
            birthday party in 4K, forever, for nothing. Then it monetizes you
            — your watch time, your attention, your face training the next ad
            model. The clip costs them pennies; it costs you everything they
            can extract from sitting next to it.
          </p>
          <p>
            That model produced an ocean of video nobody asked for and a
            generation of creators who don't own their work, can't move it,
            and can't prove they made it. The platform is the vault, the
            judge, the bouncer, and the monetization event.
          </p>
          <p className="text-foreground">
            We charge you for hosting. On purpose. Because anything that gets
            paid for gets respected, and anything that's free gets weaponized.
          </p>
        </div>
      </section>

      {/* Proof is vital */}
      <section className="mx-auto w-full max-w-4xl px-6 py-16 border-t border-border">
        <div className="flex items-center gap-3 mb-6">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <div className="font-mono text-xs text-primary">
            [ PROOF IS VITAL ]
          </div>
        </div>
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-6 max-w-3xl">
          If you can't prove you made it, you didn't.
        </h2>
        <div className="space-y-5 text-lg text-muted-foreground leading-relaxed max-w-3xl">
          <p>
            Every creator alive is one screen-record away from watching their
            work go viral under someone else's name. The current defense is a
            DM that says <em>"hey that was mine"</em> and a prayer that the
            algorithm cares. It doesn't.
          </p>
          <p>
            Content-addressing fixes this. The file's hash{" "}
            <span className="font-mono text-foreground">is</span> its name. A
            timestamp on a public chain says{" "}
            <span className="text-foreground">this exact bitstream existed
            at this exact second, signed by this exact wallet.</span>{" "}
            No reposter, no scraper, no AI-laundering pipeline can produce an
            earlier receipt for a file they didn't make.
          </p>
          <p className="text-foreground">
            The rule is simple: stamp it before you post it. Anywhere. Every
            time. The thirty seconds it takes to mint a CID and a TXC stamp is
            the cheapest insurance policy your career will ever buy.
          </p>
        </div>
      </section>

      {/* The workflow */}
      <section className="mx-auto w-full max-w-4xl px-6 py-16 border-t border-border">
        <div className="flex items-center gap-3 mb-6">
          <Flame className="h-6 w-6 text-primary" />
          <div className="font-mono text-xs text-primary">
            [ THE NEW WORKFLOW ]
          </div>
        </div>
        <ol className="space-y-6 text-lg max-w-3xl">
          <li className="flex gap-4">
            <span className="font-mono text-3xl font-bold text-primary leading-none">01</span>
            <div>
              <div className="font-bold text-foreground">Shoot.</div>
              <p className="text-muted-foreground">
                Edit. Export. Same as always.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-3xl font-bold text-primary leading-none">02</span>
            <div>
              <div className="font-bold text-foreground">Stamp it on streamTXC.</div>
              <p className="text-muted-foreground">
                Pin to IPFS, get a CID, anchor it to your wallet on-chain.
                Thirty seconds. A few cents.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="font-mono text-3xl font-bold text-primary leading-none">03</span>
            <div>
              <div className="font-bold text-foreground">Then post anywhere.</div>
              <p className="text-muted-foreground">
                TikTok, IG, X, YouTube, Farcaster, your group chat. Let them
                compress it, re-upload it, steal it. Your receipt is older
                than every copy.
              </p>
            </div>
          </li>
        </ol>
      </section>

      {/* CTA */}
      <section className="mx-auto w-full max-w-4xl px-6 py-20 border-t border-border">
        <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-6 max-w-3xl">
          You wouldn't ship code without a commit. Stop shipping video without one.
        </h2>
        <div className="flex flex-wrap gap-3 mt-10">
          <Button asChild size="lg" className="font-mono">
            <Link to="/upload">
              <Upload className="mr-2 h-4 w-4" />
              Stamp your first video
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="font-mono">
            <Link to="/about">How it works</Link>
          </Button>
        </div>
      </section>

      <Footer />
    </div>
  );
}