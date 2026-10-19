import { createFileRoute } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { name: "twitter:card", content: "summary" },
      { property: "og:type", content: "website" },
      { title: "Terms of Use — streamTXC" },
      {
        name: "description",
        content:
          "Plain-english terms for streamTXC: use at your own risk, no warranties, binding arbitration, and how disputes get resolved.",
      },
      { property: "og:title", content: "Terms of Use — streamTXC" },
      {
        property: "og:description",
        content:
          "The deal in plain english: it's an experiment, you own your keys and your content, no warranties, disputes go to arbitration.",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  const updated = "May 14, 2026";
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <article className="mx-auto max-w-3xl px-6 py-16 font-mono text-sm leading-relaxed">
          <h1 className="font-sans text-4xl font-bold tracking-tight mb-2">Terms of Use</h1>
          <p className="text-muted-foreground mb-12">Last updated: {updated}</p>

          <Section title="The short version">
            <p>
              streamTXC is an experimental, wallet-native publishing tool
              built on IPFS and the Texitcoin (TXC) blockchain. It&rsquo;s
              free to try and we hope you love it &mdash; but you use it at
              your own risk. We don&rsquo;t hold your keys, we don&rsquo;t
              host your files long-term, and we can&rsquo;t un-broadcast
              anything you put on a public blockchain or a public IPFS
              network. By using the site, you agree to what&rsquo;s below.
            </p>
          </Section>

          <Section title="Who can use this">
            <ul className="list-disc pl-6 space-y-2">
              <li>You must be old enough to enter a binding contract where you live (usually 18).</li>
              <li>You&rsquo;re responsible for your TXC wallet and the keys that control it. Lose them, you lose access &mdash; we can&rsquo;t reset them.</li>
              <li>You&rsquo;re responsible for whatever you upload, link, or comment.</li>
            </ul>
          </Section>

          <Section title="What you can&rsquo;t upload">
            <p className="mb-3">Don&rsquo;t use streamTXC for:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Anything illegal where you live or where our servers operate.</li>
              <li>CSAM. Ever. Accounts get nuked and reported, no exceptions.</li>
              <li>Content you don&rsquo;t have the rights to publish.</li>
              <li>Doxxing, targeted harassment, or threats of violence.</li>
              <li>Malware, phishing, or anything designed to harm other users.</li>
              <li>Spam, fake engagement, or attempts to game the payment system.</li>
            </ul>
            <p className="mt-3">
              We can unpin content from our infrastructure at any time, for
              any reason, with or without notice. Your TXC wallet and any
              on-chain proofs we&rsquo;ve already broadcast are not ours to
              take back.
            </p>
          </Section>

          <Section title="Your content, your call">
            <ul className="list-disc pl-6 space-y-2">
              <li>You keep ownership of whatever you upload.</li>
              <li>By uploading, you give us permission to pin, transcode, stream, and embed that content so the site can actually work.</li>
              <li>Once a CID is fetched by other IPFS nodes, copies may live on outside our control. Unpinning removes our copy &mdash; not the network&rsquo;s.</li>
              <li>On-chain events (claims, payments, takedowns) are permanent. That&rsquo;s the point.</li>
            </ul>
          </Section>

          <Section title="Payments are final">
            <p>
              TXC payments &mdash; stamps, pin fees, renewals, tips &mdash;
              settle on a public blockchain. Once a transaction confirms, we
              can&rsquo;t reverse it, refund it, or chargeback it. Double-check
              the amount and the address before you sign.
            </p>
          </Section>

          <Section title="No warranties">
            <p>
              The service is provided &ldquo;as is&rdquo; and &ldquo;as
              available.&rdquo; We make no promises that it will be
              uninterrupted, bug-free, secure, or that any specific file will
              stay pinned, playable, or reachable. IPFS gateways go down. Nodes
              fork. Wallets break. Stuff happens.
            </p>
            <p>
              To the fullest extent allowed by law, we disclaim all warranties,
              express or implied, including merchantability, fitness for a
              particular purpose, and non-infringement.
            </p>
          </Section>

          <Section title="You can&rsquo;t sue us for the moon">
            <p>
              To the fullest extent allowed by law, streamTXC and its
              contributors are not liable for indirect, incidental, special,
              consequential, or punitive damages, lost profits, lost data,
              lost crypto, or anything else that flows from your use of the
              site. If a court somewhere insists we owe you something, our
              total liability is capped at the greater of (a) the TXC fees
              you actually paid us in the 90 days before the claim, or (b)
              USD $50.
            </p>
          </Section>

          <Section title="You agree to handle disputes through arbitration">
            <p>
              If we have a disagreement we can&rsquo;t resolve informally,
              both sides agree to settle it through binding individual
              arbitration &mdash; not a court, not a jury, and not a class
              action. Arbitration will be administered by the Singapore
              International Arbitration Centre (SIAC) under its rules then
              in force, seated in Singapore, and held remotely or in a venue
              mutually agreed upon.
            </p>
            <p>
              You give up the right to participate in a class action,
              class-wide arbitration, or representative proceeding. Small
              claims court is still fair game for disputes that qualify.
            </p>
            <p>
              You can opt out of this arbitration clause within 30 days of
              first using the site by sending a signed TXC wallet message
              from the wallet you use with streamTXC, to that same wallet,
              containing the words &ldquo;arbitration opt-out.&rdquo;
            </p>
          </Section>

          <Section title="Governing law">
            <p>
              These terms are governed by the laws of Singapore, without
              regard to its conflict-of-laws rules. Any dispute not subject
              to arbitration goes to the courts of Singapore, and you
              consent to that jurisdiction.
            </p>
          </Section>

          <Section title="Third-party services">
            <p>
               streamTXC relies on Cloudflare, Lovable Cloud, IPFS, and the
              Texitcoin network. Those services have their own terms and we
              aren&rsquo;t responsible for what they do or don&rsquo;t do.
              Wallets, browser extensions, and gateways you choose to use are
              your call.
            </p>
          </Section>

          <Section title="DMCA & takedowns">
            <p>
              If you believe content on streamTXC infringes your copyright,
              send a DMCA-compliant notice through the contact channel below.
              We&rsquo;ll review it and, where appropriate, unpin the content
              from our infrastructure and broadcast a takedown event on-chain.
              We can&rsquo;t purge the content from the broader IPFS network.
            </p>
          </Section>

          <Section title="Changes">
            <p>
              We may update these terms as the project evolves. We&rsquo;ll
              bump the &ldquo;Last updated&rdquo; date at the top. Continuing
              to use the site after changes go live means you&rsquo;re cool
              with them.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Questions, DMCA notices, or arbitration opt-outs? Reach us via
              the Texitcoin community at{" "}
              <a
                href="https://texitcoin.org"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                texitcoin.org
              </a>
              .
            </p>
          </Section>
        </article>
      </main>
      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="font-sans text-xl font-semibold mb-3 tracking-tight">{title}</h2>
      <div className="text-foreground/90 space-y-3">{children}</div>
    </section>
  );
}