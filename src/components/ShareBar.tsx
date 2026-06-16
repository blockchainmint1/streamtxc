import { CopyLinkButton } from "@/components/CopyLinkButton";
import {
  Twitter,
  Facebook,
  Send,
  MessageCircle,
  Link as LinkIcon,
  Share2,
} from "lucide-react";

export function ShareBar({
  title,
  url,
  onCopy,
}: {
  title: string;
  url: string;
  onCopy: (s: string) => void;
}) {
  const text = `${title} — on-chain proof video`;
  const enc = encodeURIComponent;
  const links = [
    {
      name: "X",
      icon: Twitter,
      href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`,
    },
    {
      name: "Facebook",
      icon: Facebook,
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    },
    {
      name: "Reddit",
      icon: MessageCircle,
      href: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(title)}`,
    },
    {
      name: "Telegram",
      icon: Send,
      href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`,
    },
  ];
  const nativeShare = async () => {
    if (
      typeof navigator !== "undefined" &&
      (navigator as Navigator & { share?: (d: ShareData) => Promise<void> }).share
    ) {
      try {
        await (
          navigator as Navigator & { share: (d: ShareData) => Promise<void> }
        ).share({ title, text, url });
      } catch {
        // user cancelled
      }
    } else {
      onCopy(url);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
        share
      </span>
      {links.map((l) => (
        <a
          key={l.name}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Share on ${l.name}`}
          className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <l.icon className="h-3.5 w-3.5" />
          {l.name}
        </a>
      ))}
      <CopyLinkButton value={url} icon={<LinkIcon className="h-3.5 w-3.5" />} />
      <button
        onClick={nativeShare}
        className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-input px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        aria-label="More share options"
      >
        <Share2 className="h-3.5 w-3.5" />
        more
      </button>
    </div>
  );
}