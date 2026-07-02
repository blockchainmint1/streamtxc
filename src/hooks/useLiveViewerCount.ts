// Cheap live-viewer counter built on Supabase Realtime *presence* (not DB
// rows). Every viewer joins a per-stream channel and Realtime keeps the
// occupancy in memory — no inserts, no RLS surface, no bill spike from
// row churn. When the tab closes or the network drops, presence times out
// automatically. Anonymous viewers get a random client id so they still
// count toward the total.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

function randomId() {
  return `anon-${Math.random().toString(36).slice(2, 10)}`;
}

export function useLiveViewerCount(streamId: string | null | undefined) {
  const [count, setCount] = useState<number>(0);

  useEffect(() => {
    if (!streamId) {
      setCount(0);
      return;
    }
    const key = randomId();
    const channel = supabase.channel(`live-viewers:${streamId}`, {
      config: { presence: { key } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        // presenceState() returns { key: [meta, ...] } — sum unique keys.
        setCount(Object.keys(state).length);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ at: Date.now() });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [streamId]);

  return count;
}