import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  createBranchShareRequest,
  getMyBranchShare,
  unshareBranch,
} from "@/lib/wallet-branch.functions";
import { Button } from "@/components/ui/button";

export function BranchSharePanel() {
  const start = useServerFn(createBranchShareRequest);
  const status = useServerFn(getMyBranchShare);
  const unshare = useServerFn(unshareBranch);
  const qc = useQueryClient();
  const [pairing, setPairing] = useState<{ qrPayload: string; manifestUrl: string; token: string } | null>(null);

  const { data } = useQuery({
    queryKey: ["branch-share", pairing?.token ?? null],
    queryFn: () => status({ data: pairing ? { token: pairing.token } : {} }),
    refetchInterval: pairing ? 3000 : false,
    retry: false,
  });
  const linked = !!data?.linked;
  if (pairing && linked) {
    setPairing(null);
    toast.success("Branch shared — new videos will be filed in your wallet.");
  }

  const begin = useMutation({
    mutationFn: () => start(),
    onSuccess: (r) => setPairing({ qrPayload: r.qrPayload, manifestUrl: r.manifestUrl, token: r.token }),
    onError: (e: Error) => toast.error(e.message),
  });
  const drop = useMutation({
    mutationFn: () => unshare(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branch-share"] });
      toast.success("Branch unshared. Videos already filed stay in your wallet.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5">
      <h2 className="text-lg font-semibold uppercase tracking-wide">Your streamTXC branch</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Share your streamTXC branch from HME Wallet and every video you post is filed and
        recorded in your own wallet — view-only, it can never spend your coins.
      </p>

      {linked ? (
        <div className="mt-4 space-y-2 text-sm">
          <span className="inline-block rounded bg-primary/15 px-2 py-1 text-xs uppercase tracking-wide text-primary">
            shared · {data?.videosFiled ?? 0} video{data?.videosFiled === 1 ? "" : "s"} filed
          </span>
          <p className="text-xs text-muted-foreground">
            Wallet: <code className="break-all">{data?.identityAddress}</code> · branch{" "}
            <code>{data?.path}</code>
          </p>
          <Button variant="outline" size="sm" onClick={() => drop.mutate()} disabled={drop.isPending}>
            stop sharing
          </Button>
        </div>
      ) : pairing ? (
        <div className="mt-4 space-y-3">
          <div className="inline-block max-w-full rounded-lg border border-border bg-qr-background p-3">
            <QRCodeSVG
              value={pairing.qrPayload}
              size={256}
              marginSize={4}
              bgColor="var(--qr-background)"
              fgColor="var(--qr-foreground)"
              className="block h-auto max-w-full"
              title="Share your streamTXC branch with HME Wallet"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Scan with HME Wallet and approve. This code expires in 10 minutes.
          </p>
          {data?.requestError && <p className="text-xs text-destructive">{data.requestError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(pairing.qrPayload);
                toast.success("Link copied — paste it into HME Wallet");
              }}
            >
              copy link instead
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPairing(null)}>
              cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button className="mt-4" onClick={() => begin.mutate()} disabled={begin.isPending}>
          {begin.isPending ? "preparing…" : "share my branch"}
        </Button>
      )}
    </section>
  );
}
