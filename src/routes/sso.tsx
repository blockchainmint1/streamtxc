import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { completeHmSso, linkHmMember } from "@/lib/hm-sso.functions";
import { useWallet } from "@/lib/wallet";
import { Dialog } from "@/components/ui/dialog";
import { WalletSignInDialog } from "@/components/WalletSignInDialog";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/sso")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s.token === "string" ? s.token : undefined,
    popup: s.popup != null ? String(s.popup) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Signing in — streamTXC" },
      { name: "description", content: "Finishing your honest.money sign-in on streamTXC." },
      { property: "og:title", content: "Signing in — streamTXC" },
      { property: "og:description", content: "Finishing your honest.money sign-in on streamTXC." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SsoPage,
});

type State =
  | { kind: "working" }
  | { kind: "done" }
  | { kind: "link"; linkToken: string; email: string | null }
  | { kind: "error"; message: string };

function SsoPage() {
  const { token, popup } = Route.useSearch();
  const complete = useServerFn(completeHmSso);
  const link = useServerFn(linkHmMember);
  const { completeLogin, isAuthenticated, address } = useWallet();
  const [state, setState] = useState<State>({ kind: "working" });
  const [dialog, setDialog] = useState(false);
  const started = useRef(false);

  function finish(redirect?: string | null) {
    setState({ kind: "done" });
    if (popup === "1" && window.opener) {
      try {
        window.opener.postMessage({ type: "hm-sso-done" }, window.location.origin);
        if (window.opener.location.origin === window.location.origin) {
          window.opener.location.replace(redirect ?? "/manage");
        }
      } catch { /* opener may be on a different domain */ }
      setTimeout(() => window.close(), 600);
    } else {
      setTimeout(() => window.location.replace(redirect ?? "/manage"), 600);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) { setState({ kind: "error", message: "Missing sign-in ticket." }); return; }
    // Remove the one-use credential from the address bar and browser history.
    window.history.replaceState(null, "", `/sso${popup === "1" ? "?popup=1" : ""}`);
    let ref: string | undefined;
    try {
      ref = (window as unknown as { honestMoney?: { ref?: () => string | null } }).honestMoney?.ref?.() ?? undefined;
    } catch { /* ignore */ }
    try { localStorage.removeItem("hm:signed-out"); } catch { /* ignore */ }
    complete({ data: { token, ref: ref || undefined } })
      .then((r) => {
        if (r.kind === "signed-in") {
          completeLogin({ address: r.wallet, token: r.token, expiresAt: r.expiresAt });
          finish(r.redirect);
        } else {
          setState({ kind: "link", linkToken: r.linkToken, email: r.email });
        }
      })
      .catch((e) => setState({ kind: "error", message: e instanceof Error ? e.message : "Sign-in failed" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function doLink(linkToken: string) {
    try {
      await link({ data: { linkToken } });
      finish();
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Linking failed" });
    }
  }

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-4 px-6 py-12 font-mono">
      <h1 className="text-lg font-bold">[ SIGN IN WITH HONEST.MONEY ]</h1>
      {state.kind === "working" && <p className="text-muted-foreground">Checking your sign-in…</p>}
      {state.kind === "done" && <p className="text-primary">Signed in. You can close this window.</p>}
      {state.kind === "error" && (
        <>
          <p className="text-destructive">{state.message}</p>
          <Link to="/" className="text-primary underline">back to streamTXC</Link>
        </>
      )}
      {state.kind === "link" && (
        <>
          <p className="text-sm text-muted-foreground">
            Welcome{state.email ? `, ${state.email}` : ""}! Your streamTXC account is a TXC wallet.
            Sign in with that wallet once and we'll remember it — next time honest.money alone gets you in.
          </p>
          {isAuthenticated && address ? (
            <Button onClick={() => doLink(state.linkToken)}>
              link wallet {address.slice(0, 8)}… to my honest.money account
            </Button>
          ) : (
            <Dialog open={dialog} onOpenChange={setDialog}>
              <Button onClick={() => setDialog(true)}>sign in with my TXC wallet</Button>
              <WalletSignInDialog hideHonestMoney onClose={() => setDialog(false)} />
            </Dialog>
          )}
        </>
      )}
    </main>
  );
}
