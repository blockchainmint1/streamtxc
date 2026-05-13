import { useEffect, useRef, useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/copy-to-clipboard";

type CopyLinkButtonProps = {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  successMessage?: string;
  errorMessage?: string;
  ariaLabel?: string;
  icon?: React.ReactNode;
  onCopied?: () => void;
};

export function CopyLinkButton({
  value,
  label = "copy link",
  copiedLabel = "copied!",
  className,
  successMessage,
  errorMessage,
  ariaLabel = "Copy link",
  icon,
  onCopied,
}: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const [pulse, setPulse] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    };
  }, []);

  async function handleClick() {
    setPulse(true);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => setPulse(false), 200);

    const ok = await copyToClipboard(value, { successMessage, errorMessage });
    if (!ok) return;
    onCopied?.();
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={ariaLabel}
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-all duration-200 hover:border-primary hover:text-primary active:scale-95",
        copied && "border-primary text-primary shadow-[0_0_12px_-2px_var(--primary)]",
        pulse && "scale-95",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        icon ?? <LinkIcon className="h-3.5 w-3.5" />
      )}
      <span className="transition-opacity">{copied ? copiedLabel : label}</span>
    </button>
  );
}