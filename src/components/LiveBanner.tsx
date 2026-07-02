import { Link } from "@tanstack/react-router";
import { Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

interface LiveStreamRow {
  id: string;
  title: string;
  status: string;
}

/**
 * Full-width banner shown on the homepage when a stream is live.
 */
export function LiveBanner() {
  const [stream, setStream] = useState<LiveStreamRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const { data } = await supabase
        .from("live_streams")
        .select("id,title,status")
        .in("status", ["starting", "live"])
        .order("started_at", { ascending: false, nullsFirst: false })
        .limit(1);
      if (!cancelled) setStream((data ?? [])[0] ?? null);
    }
    refresh();
    const ch = supabase
      .channel("live-banner")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "live_streams" },
        () => refresh(),
      )
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  if (!stream) return null;

  return (
    <Link
      to="/live"
      className="block border-b border-red-500/50 bg-red-500/10 hover:bg-red-500/20 transition-colors"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-3 font-mono text-sm">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <Radio className="h-4 w-4 text-red-500" />
        <span className="text-red-500 font-bold">LIVE NOW</span>
        <span className="text-foreground truncate flex-1">— {stream.title}</span>
        <span className="text-xs text-red-500 hover:underline shrink-0">watch →</span>
      </div>
    </Link>
  );
}