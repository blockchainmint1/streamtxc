import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/brand")({
  head: () => ({
    meta: [
      { title: "Brand assets — streamTXC" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: BrandPage,
});

function BrandPage() {
  return (
    <main className="min-h-screen bg-background text-foreground p-12">
      <div className="mx-auto max-w-3xl space-y-12">
        <header>
          <h1 className="text-4xl font-bold tracking-tight">streamTXC — brand assets</h1>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            Right-click each icon and &ldquo;Save image as&hellip;&rdquo; to upload to Dropbox / app stores.
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="font-mono text-sm uppercase tracking-widest text-muted-foreground">256 × 256</h2>
          <div className="flex items-center gap-6">
            <div className="bg-white p-4 border border-border rounded">
              <img
                src="/brand/streamtxc-icon-256.png"
                alt="streamTXC icon 256"
                width={256}
                height={256}
                style={{ imageRendering: "auto" }}
              />
            </div>
            <a
              href="/brand/streamtxc-icon-256.png"
              download
              className="font-mono text-sm underline"
            >
              Download 256×256 PNG
            </a>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-mono text-sm uppercase tracking-widest text-muted-foreground">64 × 64</h2>
          <div className="flex items-center gap-6">
            <div className="bg-white p-4 border border-border rounded">
              <img
                src="/brand/streamtxc-icon-64.png"
                alt="streamTXC icon 64"
                width={64}
                height={64}
              />
            </div>
            <a
              href="/brand/streamtxc-icon-64.png"
              download
              className="font-mono text-sm underline"
            >
              Download 64×64 PNG
            </a>
          </div>
        </section>
      </div>
    </main>
  );
}