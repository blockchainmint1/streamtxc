import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { listMyVideos } from "@/lib/videos.functions";
import { useWallet } from "@/lib/wallet";
import { formatBytes, shortenHash, formatTxc } from "@/lib/fees";
import { Wallet, ArrowUpRight, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/manage")({
  head: () => ({
    meta: [{ title: "My videos — video.texitcoin" }],
  }),
  component: ManagePage,
});

function ManagePage() {
  const { address, connect } = useWallet();
  const fetchMine = useServerFn(listMyVideos);

  const { data: videos, isLoading } = useQuery({
    queryKey: ["my-videos", address],
    queryFn: () => (address ? fetchMine({ data: { wallet: address } }) : []),
    enabled: !!address,
  });

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl px-6 py-12 flex-1">
        <div className="font-mono text-xs text-primary mb-3">[ MY VIDEOS ]</div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Manage</h1>
        <p className="text-muted-foreground mb-10">
          Videos owned by your connected wallet.
        </p>

        {!address ? (
          <div className="border border-border bg-card rounded-sm p-12 text-center">
            <Wallet className="h-8 w-8 text-primary mx-auto mb-4" />
            <h2 className="font-bold mb-2">Connect a wallet</h2>
            <p className="text-sm text-muted-foreground mb-6 font-mono">
              We look up videos by wallet address — no login.
            </p>
            <Button onClick={connect} className="font-mono">
              Connect Wallet
            </Button>
          </div>
        ) : isLoading ? (
          <div className="font-mono text-muted-foreground">Loading…</div>
        ) : !videos || videos.length === 0 ? (
          <div className="border border-dashed border-border rounded-sm p-12 text-center">
            <p className="font-mono text-sm text-muted-foreground mb-4">
              No videos yet for {shortenHash(address)}
            </p>
            <Link to="/upload">
              <Button className="font-mono">Upload your first</Button>
            </Link>
          </div>
        ) : (
          <div className="border border-border rounded-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-card font-mono text-xs text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3">Title</th>
                  <th className="text-left px-4 py-3">Size</th>
                  <th className="text-left px-4 py-3">Views</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Expires</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {videos.map((v) => {
                  const exp = new Date(v.expires_at);
                  const daysLeft = Math.ceil(
                    (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
                  );
                  const expiring = daysLeft < 7;
                  return (
                    <tr
                      key={v.cid}
                      className="border-t border-border hover:bg-card/50"
                    >
                      <td className="px-4 py-3">
                        <div className="font-bold truncate max-w-xs">
                          {v.title}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground truncate max-w-xs">
                          {v.cid}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {formatBytes(v.size_bytes)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {v.view_count}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <span
                          className={
                            v.status === "active"
                              ? "text-primary"
                              : "text-muted-foreground"
                          }
                        >
                          {v.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <span
                          className={
                            expiring ? "text-destructive flex items-center gap-1" : ""
                          }
                        >
                          {expiring && <AlertTriangle className="h-3 w-3" />}
                          {daysLeft}d
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link to="/v/$cid" params={{ cid: v.cid }}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="font-mono"
                          >
                            view <ArrowUpRight className="ml-1 h-3 w-3" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}