import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  COMMENT_PRICING,
  createBoostIntent,
  createCommentIntent,
  getBoostStatus,
  getCommentStatus,
  listComments,
} from "@/lib/comments.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { formatTxc, shortenHash } from "@/lib/fees";
import { useWallet } from "@/lib/wallet";
import {
  Check,
  Copy,
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
  comment_cid: string | null;
  explorerUrl: string | null;
  ipfsUrl: string | null;
}

type PendingIntent = {
  kind: "comment" | "boost";
  id: string;
  depositWallet: string;
  amountTxc: number;
  expiresAt: string;
};

export function Comments({ cid }: { cid: string }) {
  const fetchComments = useServerFn(listComments);
  const createCommentFn = useServerFn(createCommentIntent);
  const createBoostFn = useServerFn(createBoostIntent);
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
  const { address: myWallet, isAuthenticated } = useWallet();
  const postingAs = isAuthenticated && myWallet ? myWallet : null;
  const [pending, setPending] = useState<PendingIntent | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createCommentFn({
        data: {
          videoCid: cid,
          body: body.trim(),
          amountTxc: Number(amount),
        },
      }),
    onSuccess: (res) => {
      setPending({
        kind: "comment",
        id: res.commentId,
        depositWallet: res.depositWallet,
        amountTxc: res.amountTxc,
        expiresAt: res.expiresAt,
      });
      toast.info("Send TXC to the deposit address to publish your comment", {
        description: `${res.amountTxc} TXC required • ${res.graceMinutes}-min window`,
      });
    },
    onError: (e) =>
      toast.error("Failed to create comment", {
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
        Comments are pinned to IPFS and anchored on the TXC chain — the
        on-chain tx carries the comment's content-addressed CID, so the
        body is tamper-proof and verifiable by anyone. Pay more to rank
        higher; anyone can <span className="text-primary">boost</span> a
        comment to push it back up. Split:{" "}
        <span className="text-foreground">90% creator</span> /{" "}
        <span className="text-foreground">5% commenter</span> /{" "}
        <span className="text-foreground">5% platform</span>.
      </p>

      {/* --- Composer or pending payment --- */}
      {pending && pending.kind === "comment" ? (
        <PaymentPanel
          intent={pending}
          onActive={() => {
            toast.success("Comment activated on chain");
            setPending(null);
            setBody("");
            setAmount("0.01");
            qc.invalidateQueries({ queryKey: ["comments", cid] });
          }}
          onExpire={() => {
            toast.error("Payment window expired", {
              description: "Comment was discarded.",
            });
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      ) : (
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
              {body.length}/1000 • pinned to IPFS, CID anchored on chain
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
              <Label className="font-mono text-xs flex items-center gap-1 h-4 whitespace-nowrap">
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
              <Label className="font-mono text-xs flex items-center gap-1 h-4 whitespace-nowrap">
                <Wallet className="h-3 w-3" /> Posting as
              </Label>
              <div className="mt-1 w-full bg-input border border-border rounded-sm px-2 py-2 font-mono text-sm truncate">
                {postingAs ? shortenHash(postingAs) : "anon"}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1 min-h-[22px]">
                {postingAs ? "Your signed-in wallet" : "Sign in to put your wallet on it"}
              </div>
            </div>
          </div>

          <Button
            onClick={() => create.mutate()}
            disabled={!canPost || create.isPending}
            className="mt-4 w-full font-mono"
          >
            {create.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating
                deposit address…
              </>
            ) : (
              <>
                <Rocket className="mr-2 h-4 w-4" />
                Continue to payment ({Number(amount || 0).toFixed(2)} TXC)
              </>
            )}
          </Button>
        </div>
      )}

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
              boostPending={pending?.kind === "boost" && pending.id === c.id ? pending : null}
              onCreateBoost={async (amt) => {
                try {
                  const res = await createBoostFn({
                    data: {
                      commentId: c.id,
                      amountTxc: amt,
                    },
                  });
                  setPending({
                    kind: "boost",
                    id: c.id,
                    depositWallet: res.depositWallet,
                    amountTxc: res.amountTxc,
                    expiresAt: res.expiresAt,
                  });
                  toast.info(`Send ${amt} TXC to boost`);
                  return res.boostId;
                } catch (e) {
                  toast.error("Boost failed", {
                    description:
                      e instanceof Error ? e.message : "Unknown error",
                  });
                  return null;
                }
              }}
              onBoostActive={() => {
                toast.success("Boost confirmed on chain");
                setPending(null);
                qc.invalidateQueries({ queryKey: ["comments", cid] });
              }}
              onBoostExpire={() => {
                toast.error("Boost payment window expired");
                setPending(null);
              }}
              onCancelBoost={() => setPending(null)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// --- Payment panel (shared by comment + boost) ----------------------------

function PaymentPanel({
  intent,
  onActive,
  onExpire,
  onCancel,
  boostId,
}: {
  intent: PendingIntent;
  onActive: () => void;
  onExpire: () => void;
  onCancel: () => void;
  boostId?: string | null;
}) {
  const getStatusFn = useServerFn(
    intent.kind === "comment" ? getCommentStatus : getBoostStatus,
  );
  const lookupId = intent.kind === "comment" ? intent.id : (boostId ?? "");

  const { data: status } = useQuery({
    queryKey: ["intent-status", intent.kind, lookupId],
    queryFn: () =>
      intent.kind === "comment"
        ? getStatusFn({ data: { commentId: lookupId } } as never)
        : getStatusFn({ data: { boostId: lookupId } } as never),
    enabled: !!lookupId,
    refetchInterval: 4_000,
  });

  // React to status flips.
  useEffect(() => {
    if (!status) return;
    const s = (status as { status: string }).status;
    if (s === "active") onActive();
    else if (s === "expired_unpaid") onExpire();
  }, [status, onActive, onExpire]);

  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const msLeft = Math.max(0, new Date(intent.expiresAt).getTime() - now);
  const minLeft = Math.floor(msLeft / 60000);
  const secLeft = Math.floor((msLeft % 60000) / 1000);
  const received = Number(
    (status as { payment_received_txc?: number } | undefined)
      ?.payment_received_txc ?? 0,
  );
  const required = intent.amountTxc;
  const pct = Math.min(100, (received / required) * 100);

  return (
    <div className="border-2 border-primary/60 rounded-md p-5 mb-6 bg-card/40">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="font-mono text-sm font-bold text-primary">
            WAITING FOR PAYMENT
          </span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {minLeft}:{String(secLeft).padStart(2, "0")} remaining
        </span>
      </div>

      <p className="font-mono text-xs text-muted-foreground mb-3">
        Send <span className="text-primary font-bold">{required} TXC</span> to
        the address below. Once detected, your{" "}
        {intent.kind === "comment"
          ? "comment will be pinned to IPFS and its CID anchored on chain"
          : "boost will be stamped on chain and applied"}
        .
      </p>

      <div className="flex items-center gap-2 mb-3">
        <code className="flex-1 font-mono text-xs bg-input border border-border rounded-sm px-2 py-2 break-all">
          {intent.depositWallet}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(intent.depositWallet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="border border-border rounded-sm p-2 hover:bg-primary/10 transition-colors"
          title="Copy address"
        >
          {copied ? (
            <Check className="h-4 w-4 text-primary" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground mb-1">
          <span>
            Received: {received.toFixed(8)} / {required.toFixed(8)} TXC
          </span>
          <span>{pct.toFixed(0)}%</span>
        </div>
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <button
        onClick={onCancel}
        className="text-[10px] font-mono text-muted-foreground hover:text-destructive underline"
      >
        Discard pending {intent.kind}
      </button>
    </div>
  );
}

function CommentItem({
  c,
  rank,
  boostPending,
  onCreateBoost,
  onBoostActive,
  onBoostExpire,
  onCancelBoost,
}: {
  c: CommentRow;
  rank: number;
  boostPending: PendingIntent | null;
  onCreateBoost: (amount: number) => Promise<string | null>;
  onBoostActive: () => void;
  onBoostExpire: () => void;
  onCancelBoost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [boostAmt, setBoostAmt] = useState("0.10");
  const [busy, setBusy] = useState(false);
  const [boostId, setBoostId] = useState<string | null>(null);

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
          {c.ipfsUrl && (
            <a
              href={c.ipfsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline flex items-center gap-1"
              title="Pinned comment JSON on IPFS"
            >
              ipfs <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="text-right">
          <div className="font-mono text-sm text-primary font-bold">
            {formatTxc(Number(c.boost_total_txc))}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground">
            boost total
          </div>
        </div>
      </div>

      <p className="text-sm whitespace-pre-wrap break-words">{c.body}</p>

      {boostPending ? (
        <div className="mt-3">
          <PaymentPanel
            intent={boostPending}
            boostId={boostId}
            onActive={onBoostActive}
            onExpire={onBoostExpire}
            onCancel={onCancelBoost}
          />
        </div>
      ) : (
        <>
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
              <Button
                size="sm"
                disabled={busy || Number(boostAmt) < 0.01}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const id = await onCreateBoost(Number(boostAmt));
                    if (id) {
                      setBoostId(id);
                      setOpen(false);
                    }
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
        </>
      )}
    </li>
  );
}
