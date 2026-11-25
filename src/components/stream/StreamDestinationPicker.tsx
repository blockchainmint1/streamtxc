import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { listRestreamDestinations, saveRestreamDestination } from "@/lib/restream.functions";
import { listLivePushSites, toggleLivePushSite } from "@/lib/live-push.functions";
import { RESTREAM_PRESETS, type RestreamPlatform } from "@/lib/restream-rules";

/** Tick which saved destinations this stream goes to. Ticks save right away. */
export function StreamDestinationPicker() {
  const qc = useQueryClient();
  const list = useServerFn(listRestreamDestinations);
  const listWeb = useServerFn(listLivePushSites);
  const save = useServerFn(saveRestreamDestination);
  const toggleWeb = useServerFn(toggleLivePushSite);
  const dest = useQuery({ queryKey: ["restream", "all"], queryFn: () => list({ data: {} }) });
  const web = useQuery({ queryKey: ["live-push", "all"], queryFn: () => listWeb({ data: {} }), retry: false });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["restream"] }); qc.invalidateQueries({ queryKey: ["live-push"] }); };

  const items = [
    ...(dest.data?.destinations ?? []).map((r: any) => ({
      key: `d${r.id}`, name: r.name, on: !!r.enabled,
      sub: RESTREAM_PRESETS[r.platform as RestreamPlatform]?.label ?? r.platform,
      set: (on: boolean) => save({ data: { id: r.id, name: r.name, platform: r.platform, serverUrl: r.server_url, enabled: on } }),
    })),
    ...(web.data?.sites ?? []).map((s: any) => ({
      key: `w${s.id}`, name: s.name, on: s.enabled, sub: "website",
      set: (on: boolean) => toggleWeb({ data: { id: s.id, enabled: on } }),
    })),
  ];

  if (dest.isLoading || web.isLoading) return <div className="font-mono text-xs text-muted-foreground">Loading destinations…</div>;

  return (
    <div className="space-y-1.5">
      <div className="font-mono text-xs text-muted-foreground">Send this stream to (from My saved destinations)</div>
      {items.length === 0 ? (
        <div className="font-mono text-xs text-muted-foreground">No saved destinations yet — add them in Manage → Stream.</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((i) => (
            <label key={i.key} className="flex items-center gap-2 border border-border rounded-sm px-2 py-1.5 cursor-pointer font-mono text-xs">
              <Checkbox
                checked={i.on}
                onCheckedChange={async (v) => {
                  try { await i.set(v === true); refresh(); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save that."); }
                }}
              />
              <span>{i.name}</span>
              <span className="text-muted-foreground">· {i.sub}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
