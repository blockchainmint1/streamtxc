import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EmbedPanel({
  cid,
  onCopy,
}: {
  cid: string;
  onCopy: (s: string) => void;
}) {
  const [embedW, setEmbedW] = useState(640);
  const [embedH, setEmbedH] = useState(360);
  const [autoplay, setAutoplay] = useState(false);
  const [muted, setMuted] = useState(false);
  const [startAt, setStartAt] = useState(0);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const embedSrc = `${origin}/embed/${cid}?${new URLSearchParams({
    ...(autoplay ? { autoplay: "1" } : {}),
    ...(muted ? { mute: "1" } : {}),
    ...(startAt ? { t: String(startAt) } : {}),
  }).toString()}`;
  const embedCode = `<iframe src="${embedSrc}" width="${embedW}" height="${embedH}" allow="autoplay; fullscreen" frameborder="0"></iframe>`;

  const handleCopy = () => {
    onCopy(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoplay}
            onChange={(e) => setAutoplay(e.target.checked)}
          />
          autoplay
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={muted}
            onChange={(e) => setMuted(e.target.checked)}
          />
          muted
        </label>
        <label className="flex items-center gap-2 col-span-2">
          start at (s):
          <input
            type="number"
            value={startAt}
            onChange={(e) => setStartAt(Number(e.target.value))}
            className="bg-input border border-border rounded-sm px-2 py-1 w-20"
            min={0}
          />
        </label>
        <label className="flex items-center gap-2">
          w:
          <input
            type="number"
            value={embedW}
            onChange={(e) => setEmbedW(Number(e.target.value))}
            className="bg-input border border-border rounded-sm px-2 py-1 w-full"
          />
        </label>
        <label className="flex items-center gap-2">
          h:
          <input
            type="number"
            value={embedH}
            onChange={(e) => setEmbedH(Number(e.target.value))}
            className="bg-input border border-border rounded-sm px-2 py-1 w-full"
          />
        </label>
      </div>
      <textarea
        readOnly
        value={embedCode}
        className="w-full h-24 bg-input border border-border rounded-sm p-2 font-mono text-[10px] resize-none"
      />
      <Button size="sm" onClick={handleCopy} className="w-full font-mono">
        {copied ? (
          <>
            <Check className="mr-2 h-3 w-3" /> Copied
          </>
        ) : (
          <>
            <Copy className="mr-2 h-3 w-3" /> Copy embed code
          </>
        )}
      </Button>
    </>
  );
}