import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteLivePushSite, listLivePushSites, saveLivePushSite, toggleLivePushSite } from "@/lib/live-push.functions";

type Site = Awaited<ReturnType<typeof listLivePushSites>>["sites"][number];

export function LivePushSites() {
  const list = useServerFn(listLivePushSites);
  const toggle = useServerFn(toggleLivePushSite);
  const remove = useServerFn(deleteLivePushSite);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["live-push"], queryFn: () => list(), refetchInterval: 30_000, retry: false });
  const [editing, setEditing] = useState<Site | "new" | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["live-push"] });
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't save."); } };
  if (!q.data) return null;
  const sites = q.data.sites;

  return (
    <section className="border border-border bg-card/40 rounded-sm p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl font-bold">Show my live on</h2>
        {!editing && sites.length < q.data.max && <Button size="sm" onClick={() => setEditing("new")}><Plus /> Add a site</Button>}
      </div>
      <p className="text-sm text-muted-foreground">
        Websites that play your stream only when you say so. Get the address and key from the site's owner; leave the switch off for tests. Changes take about a minute.
      </p>
      {editing && <SiteForm site={editing === "new" ? null : editing} onDone={() => { setEditing(null); void refresh(); }} />}
      {sites.length === 0 && !editing && <p className="text-sm text-muted-foreground font-mono">No sites yet.</p>}
      {sites.map((s: Site) => (
        <div key={s.id} className="flex items-center justify-between gap-3 border border-border rounded-sm px-4 py-3">
          <div className="min-w-0">
            <div className="font-bold truncate">{s.name}</div>
            <div className="text-xs font-mono text-muted-foreground truncate">{new URL(s.endpoint).host} · key …{s.keyHint}</div>
            <div className="text-xs font-mono text-muted-foreground">
              {s.showing ? "● showing your stream now" : s.enabled ? "on — will show when you go live" : "off"}
              {s.problem && s.enabled ? ` · couldn't reach it (${s.problem})` : ""}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button size="icon" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}><Pencil /></Button>
            <Button size="icon" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => { if (confirm(`Delete ${s.name}?`)) void run(() => remove({ data: { id: s.id } })); }}><Trash2 /></Button>
            <Switch checked={s.enabled} aria-label={`Show my live stream on ${s.name}`} onCheckedChange={(v) => void run(() => toggle({ data: { id: s.id, enabled: v } }))} />
          </div>
        </div>
      ))}
    </section>
  );
}

function SiteForm({ site, onDone }: { site: Site | null; onDone: () => void }) {
  const save = useServerFn(saveLivePushSite);
  const [name, setName] = useState(site?.name ?? "");
  const [endpoint, setEndpoint] = useState(site?.endpoint ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="border border-primary/50 rounded-sm p-4 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault(); setBusy(true);
        try {
          await save({ data: { ...(site ? { id: site.id } : {}), name, endpoint, ...(key ? { key } : {}) } });
          toast.success("Saved. Flip the switch on when you want your stream to show there.");
          onDone();
        } catch (err) { toast.error(err instanceof Error ? err.message : "Couldn't save."); }
        finally { setBusy(false); }
      }}
    >
      <div className="space-y-1"><Label htmlFor="lp-name">Name</Label><Input id="lp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Honest.Money Live" maxLength={60} required /></div>
      <div className="space-y-1"><Label htmlFor="lp-url">Address</Label><Input id="lp-url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://honest.money/api/public/streamtxc-live" required /></div>
      <div className="space-y-1">
        <Label htmlFor="lp-key">Key</Label>
        <Input id="lp-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={site ? `…${site.keyHint} (leave blank to keep)` : "the site's streamTXC key"} required={!site} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save site"}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
