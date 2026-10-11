import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { Toaster } from "@/components/ui/sonner";
import { useIsMobile } from "@/hooks/use-mobile";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "streamTXC - IPFS & TEXITcoin powered video streaming" },
      { name: "description", content: "Decentralized video streaming on IPFS, anchored to the TEXITcoin (TXC) blockchain. Pay-per-MB hosting, content-addressed CIDs, on-chain receipts — no accounts, no takedowns." },
      { property: "og:title", content: "streamTXC - IPFS & TEXITcoin powered video streaming" },
      { property: "og:description", content: "Decentralized, content-addressed video on IPFS with on-chain TXC receipts. No accounts, no algorithm, no silent takedowns." },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "streamTXC" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "streamTXC - IPFS & TEXITcoin powered video streaming" },
      { name: "twitter:description", content: "Decentralized, content-addressed video on IPFS with on-chain TXC receipts." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/7122b5e1-7558-4979-9fc7-80ae9d3b65b0/id-preview-72d5cdc5--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app-1778568491574.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/7122b5e1-7558-4979-9fc7-80ae9d3b65b0/id-preview-72d5cdc5--d4d0978e-e0a5-482f-8316-fceaa9ec6a46.lovable.app-1778568491574.png" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
    scripts: [
      { src: "https://honest.money/hm.js", async: true },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Organization",
              name: "streamTXC",
              url: "https://streamtxc.com",
              logo: "https://streamtxc.com/favicon.ico",
            },
            {
              "@type": "WebSite",
              name: "streamTXC",
              url: "https://streamtxc.com",
            },
          ],
        }),
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <main>
        <Outlet />
      </main>
      <ResponsiveToaster />
    </QueryClientProvider>
  );
}

function ResponsiveToaster() {
  const isMobile = useIsMobile();
  return (
    <Toaster
      richColors
      position={isMobile ? "bottom-center" : "top-right"}
      duration={2500}
    />
  );
}
