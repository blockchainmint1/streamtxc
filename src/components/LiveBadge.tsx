import { Link } from "@tanstack/react-router";
import { Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Small pulsing LIVE badge that appears when any live_stream row is live/starting.
 * Uses Supabase realtime to react instantly to status changes.
 */
export function LiveBadge() {
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const { data } = await supabase
        .from("live_streams")
        .select("id")
        .in("status", ["starting", "live"])
        .limit(1);
      if (!cancelled) setIsLive((data ?? []).length > 0);
    }
    refresh();

    const ch = supabase
      .channel("live-badge")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "live_streams" },
        () => refresh(),
      )
      .subscribe();

    const iv = setInterval(refresh, 30_000);

    return () => {
      cancelled = true;
      clearInterval(iv);
      supabase.removeChannel(ch);
    };
  }, []);

  if (!isLive) return null;

  return (
    <Link
      to="/live"
      className="inline-flex items-center gap-1.5 rounded-sm border border-red-500/60 bg-red-500/15 px-2.5 py-1 font-mono text-xs text-red-500 hover:bg-red-500 hover:text-white transition-colors"
      title="Someone is live right now"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
      <Radio className="h-3 w-3" />
      LIVE
    </Link>
  );
}