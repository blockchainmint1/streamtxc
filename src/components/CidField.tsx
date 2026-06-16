import { Copy, ExternalLink } from "lucide-react";

export function CidField({
  label,
  value,
  href,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  href?: string;
  onCopy?: (s: string) => void;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </div>
      <div className="flex items-start gap-2 mt-0.5">
        <span
          className={`flex-1 min-w-0 break-all text-xs leading-relaxed ${mono ? "font-mono" : ""}`}
        >
          {value}
        </span>
        <div className="flex items-center gap-1 shrink-0 pt-0.5">
          {onCopy && (
            <button
              onClick={() => onCopy(value)}
              className="text-muted-foreground hover:text-primary"
              aria-label={`Copy ${label}`}
            >
              <Copy className="h-3 w-3" />
            </button>
          )}
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-primary"
              aria-label={`Open ${label}`}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}