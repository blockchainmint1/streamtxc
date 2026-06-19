import { CheckCircle2, Loader2 } from "lucide-react";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { CidField as Field } from "@/components/CidField";

type Props = {
  cid: string;
  videoWallet?: string | null;
  txHash?: string | null;
  blockNumber?: number | null;
  blockHash?: string | null;
  opReturnPayload?: string | null;
  metadataCid?: string | null;
  confirmed: boolean;
  stampFailed: boolean;
  onCopy: (s: string) => void;
};

export function OnChainProofPanel({
  cid,
  videoWallet,
  txHash,
  blockNumber,
  blockHash,
  opReturnPayload,
  metadataCid,
  confirmed,
  stampFailed,
  onCopy,
}: Props) {
  return (
    <CollapsibleSection title="[ ON-CHAIN PROOF ]" defaultOpen={true}>
      <Field label="IPFS CID" value={cid} onCopy={onCopy} mono />
      {videoWallet && (
        <Field
          label="Video wallet (full chain history)"
          value={videoWallet}
          href={`https://mempool.texitcoin.org/address/${videoWallet}`}
          onCopy={onCopy}
          mono
        />
      )}
      {txHash && (
        <Field
          label="Claim tx hash"
          value={txHash}
          href={`https://mempool.texitcoin.org/tx/${txHash}`}
          onCopy={onCopy}
          mono
        />
      )}
      <div>
        <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          Confirmation
        </div>
        {confirmed ? (
          <div className="flex items-center gap-1.5 text-xs mt-0.5 text-primary font-mono">
            <CheckCircle2 className="h-3.5 w-3.5" />
            confirmed in block #{blockNumber}
          </div>
        ) : stampFailed ? (
          <div className="text-xs mt-0.5 text-destructive font-mono">
            chain stamp failed — not in mempool yet
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs mt-0.5 text-muted-foreground font-mono">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            pending — in mempool
          </div>
        )}
      </div>
      {blockHash && (
        <Field label="Block hash" value={blockHash} onCopy={onCopy} mono />
      )}
      {opReturnPayload && (
        <Field label="OP_RETURN data" value={opReturnPayload} onCopy={onCopy} mono />
      )}
      {metadataCid && (
        <Field
          label="Metadata CID (title + description, on IPFS)"
          value={metadataCid}
          href={`/api/stream/${metadataCid}`}
          onCopy={onCopy}
          mono
        />
      )}
      <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider pt-2 border-t border-border">
        TXC PROOF IS PERMANENT — DOES NOT EXPIRE.
      </p>
    </CollapsibleSection>
  );
}