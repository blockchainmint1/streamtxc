import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { listLivePushTargets, setLivePushTarget } from "@/lib/live-push.functions";

export function LivePushSites() {
  const list = useServerFn(listLivePushTargets);
  const save = useServerFn(setLivePushTarget);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["live-push"], queryFn: () => list(), refetchInterval: 30_000, retry: false });
  if (!q.data?.allowed) return null;
  return (
    <section className="border border-border bg-card/40 rounded-sm p-5 space-y-3">
      <h2 className="text-2xl font-bold">Show my live on</h2>
      <p className="text-sm text-muted-foreground">
        These sites only show your stream when the switch is on. Leave them off for tests. Changes take about a minute.
      </p>
      {q.data.sites.map((s) => (
        <label key={s.site} className="flex items-center justify-between gap-3 border border-border rounded-sm px-4 py-3">
          <span className="min-w-0">
            <span className="block font-bold">{s.label}</span>
            <span className="block text-xs font-mono text-muted-foreground">
              {s.showing ? "● showing your stream now" : s.enabled ? "on — will show when you go live" : "off"}
              {s.problem && s.enabled ? ` · couldn't reach it (${s.problem})` : ""}
            </span>
          </span>
          <Switch
            checked={s.enabled}
            aria-label={`Show my live stream on ${s.label}`}
            onCheckedChange={async (v) => {
              try { await save({ data: { site: s.site as "honest-money" | "texitcoin", enabled: v } }); await qc.invalidateQueries({ queryKey: ["live-push"] }); }
              catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save."); }
            }}
          />
        </label>
      ))}
    </section>
  );
}
