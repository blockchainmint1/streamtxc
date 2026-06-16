import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  QrCode,
} from "lucide-react";
import {
  formatTxc,
  formatDate,
  PAYMENT_GRACE_HOURS,
  PAYMENT_DUST_TXC,
} from "@/lib/fees";

export function PaymentPanel({
  required,
  received,
  wallet,
  paidAt,
  createdAt,
  expiresAt,
  monthsPrepaid,
  onCopy,
}: {
  required: number;
  received: number;
  wallet: string;
  paidAt: string | null;
  createdAt: string;
  expiresAt: string;
  monthsPrepaid: number;
  onCopy: (s: string) => void;
}) {
  const effectiveReceived = received >= PAYMENT_DUST_TXC ? received : 0;
  const paid = paidAt != null || effectiveReceived >= required;
  const partial = !paid && effectiveReceived > 0;
  const remaining = Math.max(0, +(required - effectiveReceived).toFixed(8));
  const ageHrs = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  const graceLeft = Math.max(0, PAYMENT_GRACE_HOURS - ageHrs);
  const [showQr, setShowQr] = useState(false);
  const monthlyRate = monthsPrepaid > 0 ? required / monthsPrepaid : required;
  const qrPayload =
    remaining > 0
      ? `texitcoin:${wallet}?amount=${remaining}`
      : `texitcoin:${wallet}`;

  return (
    <>
      {paid ? (
        <>
          <div className="flex items-center gap-1.5 text-xs text-primary font-mono">
            <CheckCircle2 className="h-3.5 w-3.5" />
            paid · {formatTxc(effectiveReceived)}
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            stays live until{" "}
            <span className="text-foreground">{formatDate(expiresAt)}</span>
            {monthlyRate > 0 && (
              <>
                {" "}· extend life by sending more TXC ({formatTxc(monthlyRate)} = +1 month)
              </>
            )}
          </div>
          <WalletBlock
            wallet={wallet}
            showQr={showQr}
            setShowQr={setShowQr}
            onCopy={onCopy}
            qrPayload={qrPayload}
            label="top-up address"
            qrCaption={`${wallet.slice(0, 12)}…${wallet.slice(-8)}`}
          />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 font-mono text-xs">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                amount due
              </div>
              <div className="text-primary font-bold">{formatTxc(remaining)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
                received
              </div>
              <div>{formatTxc(effectiveReceived)}</div>
            </div>
          </div>
          {partial && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-500 font-mono">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              partial payment received — send the remainder to confirm
            </div>
          )}
          {monthlyRate > 0 && (
            <div className="font-mono text-[11px] text-muted-foreground">
              rate: {formatTxc(monthlyRate)} per month · overpay extends hosting automatically
            </div>
          )}
          <WalletBlock
            wallet={wallet}
            showQr={showQr}
            setShowQr={setShowQr}
            onCopy={onCopy}
            qrPayload={qrPayload}
            label="send TXC to"
            qrCaption={`${formatTxc(remaining)} → ${wallet.slice(0, 12)}…${wallet.slice(-8)}`}
          />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Send exactly the amount above from any TXC wallet. Confirmation is
            automatic — your video stays live as soon as the payment lands.
            Unpaid videos are unpinned after{" "}
            <span className="text-foreground">
              {graceLeft <= 0
                ? "0h"
                : graceLeft >= 48
                  ? `${(graceLeft / 24).toFixed(1)} days`
                  : `${graceLeft.toFixed(1)}h`}
            </span>
            .
          </p>
          <a
            href={`https://mempool.texitcoin.org/address/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline"
          >
            view address on mempool <ExternalLink className="h-3 w-3" />
          </a>
        </>
      )}
    </>
  );
}

function WalletBlock({
  wallet,
  showQr,
  setShowQr,
  onCopy,
  qrPayload,
  label,
  qrCaption,
}: {
  wallet: string;
  showQr: boolean;
  setShowQr: (fn: (v: boolean) => boolean) => void;
  onCopy: (s: string) => void;
  qrPayload: string;
  label: string;
  qrCaption: string;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate text-xs font-mono bg-input border border-border rounded-sm px-2 py-1.5">
          {wallet}
        </code>
        <button
          onClick={() => onCopy(wallet)}
          className="text-muted-foreground hover:text-primary"
          aria-label="Copy address"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setShowQr((v) => !v)}
          className={`transition-colors ${showQr ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
          aria-label="Show QR code"
        >
          <QrCode className="h-3.5 w-3.5" />
        </button>
      </div>
      {showQr && (
        <div className="mt-3 flex flex-col items-center gap-2 bg-white p-3 rounded-sm">
          <QRCodeSVG value={qrPayload} size={180} level="M" marginSize={2} />
          <div className="font-mono text-[10px] text-black text-center break-all">
            {qrCaption}
          </div>
        </div>
      )}
    </div>
  );
}