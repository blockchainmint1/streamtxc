import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  boostComment,
  COMMENT_PRICING,
  listComments,
  postComment,
} from "@/lib/comments.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { formatTxc, shortenHash } from "@/lib/fees";
import {
  ExternalLink,
  Flame,
  Loader2,
  MessageSquare,
  Rocket,
  Wallet,
} from "lucide-react";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Decay-weighted score: a freshly-boosted comment outranks a long-cold one,
 * but a cold heavyweight still beats a tiny new one. 24h half-life.
 */
function decayScore(boostTxc: number, lastBoostAt: string): number {
  const ageHours =
    (Date.now() - new Date(lastBoostAt).getTime()) / (1000 * 60 * 60);
  return boostTxc / (1 + ageHours / 24);
}

interface CommentRow {
  id: string;
  body: string;
  commenter_wallet: string | null;
  initial_payment_txc: number;
  boost_total_txc: number;
  last_boost_at: string;
  created_at: string;
  tx_hash: string | null;
  explorerUrl: string | null;
}

export function Comments({ cid }: { cid: string }) {
  const fetchComments = useServerFn(listComments);
  const postFn = useServerFn(postComment);
  const boostFn = useServerFn(boostComment);
  const qc = useQueryClient();

  const { data: comments = [], isLoading } = useQuery<CommentRow[]>({
    queryKey: ["comments", cid],
    queryFn: () => fetchComments({ data: { videoCid: cid } }),
    refetchInterval: 15_000,
  });

  const ranked = useMemo(() => {
    return [...comments].sort(
      (a, b) =>
        decayScore(Number(b.boost_total_txc), b.last_boost_at) -
        decayScore(Number(a.boost_total_txc), a.last_boost_at),
    );
  }, [comments]);

  // --- Compose form state ---
  const [body, setBody] = useState("");
  const [amount, setAmount] = useState<string>("0.01");
  const [wallet, setWallet] = useState("");

  const post = useMutation({
    mutationFn: () =>
      postFn({
        data: {
          videoCid: cid,
          body: body.trim(),
          amountTxc: Number(amount),
          commenterWallet: wallet.trim() || undefined,
        },
      }),
    onSuccess: (res) => {
      toast.success("Comment posted on chain", {
        description: res.txHash
          ? `Anchored: ${shortenHash(res.txHash)}`
          : "Stamp deferred (chain RPC offline)",
      });
      setBody("");
      setAmount("0.01");
      qc.invalidateQueries({ queryKey: ["comments", cid] });
    },
    onError: (e) =>
      toast.error("Failed to post", {
        description: e instanceof Error ? e.message : "Unknown error",
      }),
  });

  const canPost =
    body.trim().length > 0 &&
    body.trim().length <= 1000 &&
    Number(amount) >= COMMENT_PRICING.minTxc &&
    Number(amount) <= 10000;

  const charPct = Math.min(100, (body.length / 1000) * 100);

  return (
    <section className="mt-10 border-t border-border pt-8">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="h-5 w-5 text-primary" />
        <h2 className="font-mono text-lg font-bold">PAY-TO-COMMENT</h2>
        <span className="font-mono text-xs text-muted-foreground">
          ({ranked.length})
        </span>
      </div>

      <p className="text-xs text-muted-foreground font-mono mb-6 leading-relaxed">
        Comments are anchored on the TXC chain. Pay more to rank higher;
        anyone can <span className="text-primary">boost</span> a comment to
        push it back up. Split:{" "}
        <span className="text-foreground">90% creator</span> /{" "}
        <span className="text-foreground">5% hosting</span> /{" "}
        <span className="text-foreground">5% platform</span>.
      </p>

      {/* --- Composer --- */}
      <div className="border border-border rounded-md p-4 mb-6 bg-card/30">
        <Label className="font-mono text-xs">Your comment</Label>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 1000))}
          placeholder="Say something on chain forever..."
          className="mt-1 font-mono text-sm bg-input border-border min-h-[80px]"
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] font-mono text-muted-foreground">
            {body.length}/1000
          </span>
          <div className="h-1 w-24 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${charPct}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
          <div>
            <Label className="font-mono text-xs">
              Pay (TXC) — min {COMMENT_PRICING.minTxc}
            </Label>
            <input
              type="number"
              step="0.01"
              min={COMMENT_PRICING.minTxc}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full bg-input border border-border rounded-sm px-2 py-2 font-mono text-sm"
            />
            <div className="flex gap-1 mt-1">
              {["0.01", "0.10", "1.00", "10.00"].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAmount(v)}
                  className="text-[10px] font-mono px-2 py-0.5 border border-border rounded-sm hover:bg-primary/10 transition-colors"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label className="font-mono text-xs flex items-center gap-1">
              <Wallet className="h-3 w-3" /> Your wallet (optional)
            </Label>
            <input
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="0x… (leave blank to post anon)"
              className="mt-1 w-full bg-input border border-border rounded-sm px-2 py-2 font-mono text-sm"
            />
          </div>
        </div>

        <Button
          onClick={() => post.mutate()}
          disabled={!canPost || post.isPending}
          className="mt-4 w-full font-mono"
        >
          {post.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Stamping…
            </>
          ) : (
            <>
              <Rocket className="mr-2 h-4 w-4" />
              Post for {Number(amount || 0).toFixed(2)} TXC
            </>
          )}
        </Button>
      </div>

      {/* --- List --- */}
      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground font-mono text-sm">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading…
        </div>
      ) : ranked.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground font-mono text-sm border border-dashed border-border rounded-md">
          No comments yet. Be the first to stamp one on chain.
        </div>
      ) : (
        <ul className="space-y-3">
          {ranked.map((c, i) => (
            <CommentItem
              key={c.id}
              c={c}
              rank={i}
              onBoost={async (amt, w) => {
                try {
                  const res = await boostFn({
                    data: {
                      commentId: c.id,
                      amountTxc: amt,
                      boosterWallet: w || undefined,
                    },
                  });
                  toast.success(`Boosted +${amt} TXC`, {
                    description: res.txHash
                      ? `Anchored: ${shortenHash(res.txHash)}`
                      : "Stamp deferred",
                  });
                  qc.invalidateQueries({ queryKey: ["comments", cid] });
                } catch (e) {
                  toast.error("Boost failed", {
                    description:
                      e instanceof Error ? e.message : "Unknown error",
                  });
                }
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentItem({
  c,
  rank,
  onBoost,
}: {
  c: CommentRow;
  rank: number;
  onBoost: (amount: number, wallet: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [boostAmt, setBoostAmt] = useState("0.10");
  const [boostWallet, setBoostWallet] = useState("");
  const [busy, setBusy] = useState(false);

  const isHot = rank === 0 && Number(c.boost_total_txc) >= 0.1;

  return (
    <li className="border border-border rounded-md p-4 bg-card/40">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap text-xs font-mono">
          {isHot && (
            <span className="flex items-center gap-1 text-amber-500">
              <Flame className="h-3 w-3" /> HOT
            </span>
          )}
          <span className="text-muted-foreground">
            {c.commenter_wallet ? (
              <span className="text-foreground">
                {shortenHash(c.commenter_wallet)}
              </span>
            ) : (
              "anon"
            )}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{timeAgo(c.created_at)}</span>
          {c.explorerUrl && (
            <a
              href={c.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline flex items-center gap-1"
            >
              chain <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="text-right">
          <div className="font-mono text-sm text-primary font-bold">
            {formatTxc(Number(c.boost_total_txc))} TXC
          </div>
          <div className="text-[10px] font-mono text-muted-foreground">
            boost total
          </div>
        </div>
      </div>

      <p className="text-sm whitespace-pre-wrap break-words">{c.body}</p>

      <div className="mt-3 flex items-center justify-between">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
        >
          <Rocket className="h-3 w-3" />
          {open ? "Cancel" : "Boost"}
        </button>
      </div>

      {open && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
          <div>
            <Label className="font-mono text-[10px]">Amount (TXC)</Label>
            <input
              type="number"
              step="0.01"
              min={0.01}
              value={boostAmt}
              onChange={(e) => setBoostAmt(e.target.value)}
              className="w-full bg-input border border-border rounded-sm px-2 py-1.5 font-mono text-sm"
            />
          </div>
          <div>
            <Label className="font-mono text-[10px]">Wallet (optional)</Label>
            <input
              value={boostWallet}
              onChange={(e) => setBoostWallet(e.target.value)}
              placeholder="0x…"
              className="w-full bg-input border border-border rounded-sm px-2 py-1.5 font-mono text-xs"
            />
          </div>
          <Button
            size="sm"
            disabled={busy || Number(boostAmt) < 0.01}
            onClick={async () => {
              setBusy(true);
              try {
                await onBoost(Number(boostAmt), boostWallet.trim());
                setOpen(false);
                setBoostAmt("0.10");
              } finally {
                setBusy(false);
              }
            }}
            className="font-mono"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Flame className="mr-1 h-3 w-3" /> Boost
              </>
            )}
          </Button>
        </div>
      )}
    </li>
  );
}