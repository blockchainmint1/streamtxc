import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOutEverywhere } from "@/lib/wallet-auth.functions";
import { disconnectWallet } from "@/lib/wallet";

/** Lets someone cancel every sign-in at once, e.g. after losing a phone. */
export function SignInSecuritySection() {
  const run = useServerFn(signOutEverywhere);
  const [busy, setBusy] = useState(false);
  return (
    <section id="sign-in-security" className="mt-16 border-t border-border pt-8 scroll-mt-20">
      <div className="font-mono text-xs text-primary mb-3">[ SIGN-IN SECURITY ]</div>
      <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
        <ShieldCheck className="h-5 w-5" /> Sign out everywhere
      </h2>
      <p className="text-sm text-muted-foreground mb-4 max-w-2xl">
        Lost a phone or signed in on someone else's computer? This signs your account out on every device,
        including this one. You'll just sign in again here afterwards.
      </p>
      <Button
        variant="outline"
        className="font-mono"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm("Sign out on every device, including this one?")) return;
          setBusy(true);
          try {
            const r = await run();
            toast.success(`Signed out of ${r.signedOut} ${r.signedOut === 1 ? "device" : "devices"}.`);
            disconnectWallet();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't sign out everywhere");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Signing out…" : "Sign out everywhere"}
      </Button>
    </section>
  );
}
