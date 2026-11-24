import { useState } from "react";
import { Globe } from "lucide-react";
import { deleteLivePushSite, listLivePushSites, saveLivePushSite, toggleLivePushSite } from "@/lib/live-push.functions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Radio, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  applyRestreamDestinations, deleteRestreamDestination, listRestreamDestinations, saveRestreamDestination,
} from "@/lib/restream.functions";
import { RESTREAM_PRESETS, type RestreamPlatform } from "@/lib/restream-rules";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

export function RestreamDestinations() {
  const qc = useQueryClient();
  const list = useServerFn(listRestreamDestinations);
  const save = useServerFn(saveRestreamDestination);
  const del = useServerFn(deleteRestreamDestination);
  const apply = useServerFn(applyRestreamDestinations);
  const { data, isLoading } = useQuery({ queryKey: ["restream"], queryFn: () => list() });
  const listWeb = useServerFn(listLivePushSites);
  const saveWeb = useServerFn(saveLivePushSite);
  const toggleWeb = useServerFn(toggleLivePushSite);
  const delWeb = useServerFn(deleteLivePushSite);
  const web = useQuery({ queryKey: ["live-push"], queryFn: () => listWeb(), refetchInterval: 30_000, retry: false });
  const refreshWeb = () => qc.invalidateQueries({ queryKey: ["live-push"] });
  const [platform, setPlatform] = useState<RestreamPlatform | "website">("youtube");
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [streamKey, setStreamKey] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["restream"] });
  const isWeb = platform === "website";
  const preset = isWeb ? { label: "Website", help: "Get the address and key from the website's owner." } : RESTREAM_PRESETS[platform];

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (platform === "website") {
        await saveWeb({ data: { name: name || "Website", endpoint: serverUrl, key: streamKey } });
        toast.success("Saved. Flip its switch on when you want your stream to show there.");
        refreshWeb();
      } else {
        await save({ data: { name: name || preset.label, platform, serverUrl: serverUrl || undefined, streamKey } });
        toast.success("Saved. Press “Update my live channel” while it's off.");
        refresh();
      }
      setName(""); setServerUrl(""); setStreamKey("");
    } catch (err) { toast.error(msg(err)); } finally { setBusy(false); }
  }

  async function applyNow() {
    setBusy(true);
    try {
      const r = await apply();
      toast.success(r.count ? `Your live channel will now also go to ${r.count} other site${r.count > 1 ? "s" : ""}.` : "Extra destinations removed from your live channel.");
    } catch (err) { toast.error(msg(err)); } finally { setBusy(false); }
  }

  const rows = data?.destinations ?? [];
  const sites = web.data?.sites ?? [];
  const canAdd = isWeb ? sites.length < (web.data?.max ?? 5) : rows.length < (data?.max ?? 5);
  return (
    <div className="space-y-5">
      {isLoading ? (
        <div className="font-mono text-sm text-muted-foreground">Loading…</div>
      ) : rows.length + sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">No extra destinations yet — your stream goes to streamTXC only.</p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-sm">
          {sites.map((s: any) => (
            <li key={s.id} className="flex items-center gap-3 p-3">
              <Globe className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{s.name}</div>
                <div className="font-mono text-xs text-muted-foreground truncate">
                  {new URL(s.endpoint).host} · key …{s.keyHint} · {s.showing ? "showing now" : s.enabled ? "shows when you go live" : "off"}
                  {s.problem && s.enabled ? " · couldn't reach it" : ""}
                </div>
              </div>
              <Switch checked={s.enabled} aria-label={`Show my live stream on ${s.name}`} onCheckedChange={async (v) => {
                try { await toggleWeb({ data: { id: s.id, enabled: v } }); refreshWeb(); } catch (err) { toast.error(msg(err)); }
              }} />
              <Button variant="ghost" size="icon" aria-label={`Remove ${s.name}`} onClick={async () => {
                try { await delWeb({ data: { id: s.id } }); refreshWeb(); } catch (err) { toast.error(msg(err)); }
              }}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
          {rows.map((r: any) => (
            <li key={r.id} className="flex items-center gap-3 p-3">
              <Radio className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{r.name}</div>
                <div className="font-mono text-xs text-muted-foreground truncate">{r.server_url} · key {r.key_hint}</div>
              </div>
              <Switch
                checked={r.enabled}
                aria-label={`Send to ${r.name}`}
                onCheckedChange={async (v) => {
                  try { await save({ data: { id: r.id, name: r.name, platform: r.platform, serverUrl: r.server_url, enabled: v } }); refresh(); }
                  catch (err) { toast.error(msg(err)); }
                }}
              />
              <Button variant="ghost" size="icon" aria-label={`Remove ${r.name}`} onClick={async () => { await del({ data: { id: r.id } }); refresh(); }}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-2 border border-dashed border-border rounded-sm p-4">
          <div className="space-y-1.5">
            <Label htmlFor="rs-platform">Site</Label>
            <select
              id="rs-platform" value={platform} onChange={(e) => setPlatform(e.target.value as RestreamPlatform | "website")}
              className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
            >
              {(Object.keys(RESTREAM_PRESETS) as RestreamPlatform[]).map((p) => <option key={p} value={p}>{RESTREAM_PRESETS[p].label}</option>)}
              <option value="website">Website (Honest.Money, TEXITcoin.org…)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rs-name">Name</Label>
            <Input id="rs-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${preset.label} channel`} maxLength={60} />
          </div>
          {(platform === "custom" || isWeb) && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="rs-url">{isWeb ? "Website address" : "Server URL"}</Label>
              <Input id="rs-url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder={isWeb ? "https://honest.money/api/public/streamtxc-live" : "rtmp://… or rtmps://…"} required />
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="rs-key">{isWeb ? "Key" : "Stream key"}</Label>
            <Input id="rs-key" type="password" autoComplete="off" value={streamKey} onChange={(e) => setStreamKey(e.target.value)} required />
            <p className="text-xs text-muted-foreground">{preset.help} We store it locked and only show the last 4 characters.</p>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy} className="font-mono">Add destination</Button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={applyNow} disabled={busy} className="font-mono gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Update my live channel
        </Button>
        <span className="text-xs text-muted-foreground">Only works while your live channel is fully off. Changes take effect on your next Go Live.</span>
      </div>
    </div>
  );
}
