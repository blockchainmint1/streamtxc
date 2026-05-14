import { createFileRoute } from "@tanstack/react-router";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — StreamTXC" },
      {
        name: "description",
        content:
          "How StreamTXC handles your data: wallet IDs, uploaded video CIDs, and third-party imports from Dropbox, Google Drive and WeTransfer.",
      },
      { property: "og:title", content: "Privacy Policy — StreamTXC" },
      {
        property: "og:description",
        content:
          "Wallet-only identity, no email, no tracking. Imported files are streamed once to IPFS and never stored on our servers.",
      },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  const updated = "May 14, 2026";
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <article className="mx-auto max-w-3xl px-6 py-16 font-mono text-sm leading-relaxed">
          <h1 className="font-sans text-4xl font-bold tracking-tight mb-2">Privacy Policy</h1>
          <p className="text-muted-foreground mb-12">Last updated: {updated}</p>

          <Section title="The short version">
            <p>
              StreamTXC is a wallet-native publishing tool. We don&rsquo;t ask
              for your email, your name, or your phone number. The only
              identifier we use is your TXC wallet address, which is already
              public on-chain. Files you upload are pinned to IPFS via Pinata
              and addressed by their CID &mdash; the content hash &mdash; not
              by you.
            </p>
          </Section>

          <Section title="What we collect">
            <ul className="list-disc pl-6 space-y-2">
              <li>
                <strong>Your TXC wallet address.</strong> Used to associate
                uploads, comments, and payments with you. This is public
                information.
              </li>
              <li>
                <strong>Content you upload.</strong> Video files you publish
                are pinned to IPFS. Once pinned, anyone with the CID can
                fetch them &mdash; that&rsquo;s how IPFS works. Don&rsquo;t
                upload anything you wouldn&rsquo;t want public.
              </li>
              <li>
                <strong>On-chain payment records.</strong> Stamps and pin
                fees are settled in TXC. Those transactions are recorded on
                the Texitcoin blockchain.
              </li>
              <li>
                <strong>Standard server logs.</strong> IP address, user
                agent, and request paths, kept short-term for abuse
                prevention and debugging.
              </li>
            </ul>
          </Section>

          <Section title="What we don&rsquo;t collect">
            <ul className="list-disc pl-6 space-y-2">
              <li>No email, name, phone number, or government ID.</li>
              <li>No third-party analytics or advertising trackers.</li>
              <li>No social-graph or contact-list scraping.</li>
              <li>No private keys &mdash; signing happens in your wallet.</li>
            </ul>
          </Section>

          <Section title="Importing from Dropbox, Google Drive, and WeTransfer">
            <p className="mb-3">
              When you import a video from a third-party service, here&rsquo;s
              exactly what happens:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>
                You explicitly select a single file (via a Chooser dialog or
                a share link you paste).
              </li>
              <li>
                We request the minimum scopes needed to read that one file
                &mdash; for Dropbox: <code>files.metadata.read</code>,{" "}
                <code>files.content.read</code>, and{" "}
                <code>sharing.read</code>. Read-only.
              </li>
              <li>
                The file is streamed once from the source through our server
                directly to Pinata for IPFS pinning. We do not write a copy
                to disk.
              </li>
              <li>
                We do not store your Dropbox/Google credentials. OAuth tokens,
                if used, live in an encrypted browser session and expire
                automatically.
              </li>
              <li>
                We do not browse, list, or access any other files in your
                connected account.
              </li>
            </ul>
          </Section>

          <Section title="Cookies & local storage">
            <p>
              We use a small amount of browser local storage to remember your
              connected wallet and UI preferences. No cookies are used for
              tracking or advertising.
            </p>
          </Section>

          <Section title="Data deletion">
            <p>
              You can unpin your own uploads at any time from{" "}
              <a href="/manage" className="underline">
                /manage
              </a>
              . Note that IPFS is a public network: once a CID has been
              fetched by other nodes, copies may persist outside our control.
              Unpinning removes our copy and stops paying for storage.
            </p>
          </Section>

          <Section title="Third-party services we rely on">
            <ul className="list-disc pl-6 space-y-2">
              <li>
                <strong>Pinata</strong> &mdash; IPFS pinning provider.
              </li>
              <li>
                <strong>Cloudflare</strong> &mdash; edge hosting and
                CDN-style streaming.
              </li>
              <li>
                <strong>Supabase</strong> &mdash; metadata storage (CIDs,
                titles, comments tied to wallet addresses).
              </li>
              <li>
                <strong>Texitcoin (TXC)</strong> &mdash; on-chain payment
                settlement.
              </li>
            </ul>
          </Section>

          <Section title="Contact">
            <p>
              Questions about this policy? Reach out via the Texitcoin
              community at{" "}
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