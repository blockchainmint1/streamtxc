import { createServerFn } from "@tanstack/react-start";

// Public (unauthenticated) lookup of a wallet's currently-live stream.
// Returns only playback-safe fields. Uses supabaseAdmin because owner_wallet
// is not exposed via anon SELECT on live_streams.
export const getLiveStreamByWallet = createServerFn({ method: "GET" })
  .inputValidator((input: { wallet: string }) => {
    const w = String(input?.wallet ?? "").trim();
    if (!/^[A-Za-z0-9]{20,80}$/.test(w)) {
      throw new Error("Invalid wallet");
    }
    return { wallet: w };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data: rows, error } = await supabaseAdmin
      .from("live_streams")
      .select("id,title,hls_url,status,started_at")
      .eq("owner_wallet", data.wallet)
      .in("status", ["starting", "live"])
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (error) return { stream: null };
    const row = rows?.[0];
    if (!row) return { stream: null };
    return {
      stream: {
        id: row.id as string,
        title: (row.title as string) ?? "",
        hls_url: (row.hls_url as string | null) ?? null,
        status: row.status as string,
      },
    };
  });