import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listRestreamDestinations } from "@/lib/restream.functions";
import { listLivePushSites } from "@/lib/live-push.functions";
import { RESTREAM_PRESETS, type RestreamPlatform } from "@/lib/restream-rules";

/** Shows which saved destinations are switched on for the current stream. */
export function StreamActiveDestinations() {
  const list = useServerFn(listRestreamDestinations);
  const listWeb = useServerFn(listLivePushSites);
  const dest = useQuery({ queryKey: ["restream", "all"], queryFn: () => list({ data: {} }) });
  const web = useQuery({ queryKey: ["live-push", "all"], queryFn: () => listWeb({ data: {} }), retry: false });

  if (dest.isLoading || web.isLoading) return null;

  const on = [
    ...(dest.data?.destinations ?? [])
      .filter((r: any) => r.enabled)
      .map((r: any) => ({ key: `d${r.id}`, name: r.name, sub: RESTREAM_PRESETS[r.platform as RestreamPlatform]?.label ?? r.platform })),
    ...(web.data?.sites ?? [])
      .filter((s: any) => s.enabled)
      .map((s: any) => ({ key: `w${s.id}`, name: s.name, sub: "website" })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      <span className="font-mono text-[11px] text-muted-foreground">going to:</span>
      <span className="font-mono text-[11px] border border-border rounded-sm px-1.5 py-0.5">streamTXC</span>
      {on.length === 0 ? (
        <span className="font-mono text-[11px] text-muted-foreground">only — no extra destinations on</span>
      ) : (
        on.map((d) => (
          <span key={d.key} className="font-mono text-[11px] border border-border rounded-sm px-1.5 py-0.5">
            {d.name} <span className="text-muted-foreground">· {d.sub}</span>
          </span>
        ))
      )}
    </div>
  );
}
