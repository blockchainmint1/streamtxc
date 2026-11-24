import { useState, type ReactNode } from "react";
import { Wallet } from "lucide-react";
import { useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { WalletSignInDialog } from "@/components/WalletSignInDialog";

/** Uploading requires an Honest.Money account; anonymous uploads are closed. */
export function UploadSignInGate({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useWallet();
  const [open, setOpen] = useState(false);
  if (isAuthenticated) return <>{children}</>;
  return (
    <div className="border border-dashed border-border rounded-sm p-12 text-center space-y-4">
      <p className="font-mono text-sm text-muted-foreground">
        Sign in with your Honest.Money account to upload videos.
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="font-mono gap-2">
            <Wallet className="h-4 w-4" /> Sign in to upload
          </Button>
        </DialogTrigger>
        <WalletSignInDialog onClose={() => setOpen(false)} />
      </Dialog>
      <p className="text-xs text-muted-foreground">
        No account yet?{" "}
        <a href="https://honest.money" target="_blank" rel="noreferrer" className="text-primary hover:underline">
          Join honest.money
        </a>
      </p>
    </div>
  );
}
