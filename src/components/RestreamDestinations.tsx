import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Globe, Radio, Trash2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  applyRestreamDestinations, deleteRestreamDestination, listRestreamDestinations, saveRestreamDestination, useSavedRestreamDestination,
} from "@/lib/restream.functions";
import { deleteLivePushSite, listLivePushSites, saveLivePushSite, toggleLivePushSite, useSavedLivePushSite } from "@/lib/live-push.functions";
import { RESTREAM_PRESETS, type RestreamPlatform } from "@/lib/restream-rules";
import { cn } from "@/lib/utils";

const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

/**
 * Without roomId: your saved destinations (reusable; also used when you stream from OBS/StreamYard).
 * With roomId: the destinations this studio sends to.
 */
export function RestreamDestinations({ roomId, compact }: { roomId?: string; compact?: boolean } = {}) {
  const qc = useQueryClient();
  const list = useServerFn(listRestreamDestinations);
  const save = useServerFn(saveRestreamDestination);
  const del = useServerFn(deleteRestreamDestination);
  const apply = useServerFn(applyRestreamDestinations);
  const copy = useServerFn(useSavedRestreamDestination);
  const listWeb = useServerFn(listLivePushSites);
  const saveWeb = useServerFn(saveLivePushSite);
  const toggleWeb = useServerFn(toggleLivePushSite);
  const delWeb = useServerFn(deleteLivePushSite);
  const copyWeb = useServerFn(useSavedLivePushSite);
  const scoped = roomId ? { roomId } : {};
  const key = roomId ?? "all";

  const dest = useQuery({ queryKey: ["restream", key], queryFn: () => list({ data: scoped }) });
  const web = useQuery({ queryKey: ["live-push", key], queryFn: () => listWeb({ data: scoped }), refetchInterval: 30_000, retry: false });
  const savedDest = useQuery({ queryKey: ["restream", "all"], queryFn: () => list({ data: {} }), enabled: !!roomId });
  const savedWeb = useQuery({ queryKey: ["live-push", "all"], queryFn: () => listWeb({ data: {} }), enabled: !!roomId, retry: false });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["restream"] }); qc.invalidateQueries({ queryKey: ["live-push"] }); };

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const rows = dest.data?.destinations ?? [];
  const sites = web.data?.sites ?? [];
  const max = dest.data?.max ?? 5;

  // Saved ones not already in this studio (matched by name + address).
  const inStudio = new Set([...rows.map((r: any) => `d|${r.name}|${r.server_url}`), ...sites.map((s: any) => `w|${s.name}|${s.endpoint}`)]);
  const pickable = roomId
    ? [
        ...(savedDest.data?.destinations ?? []).filter((r: any) => !inStudio.has(`d|${r.name}|${r.server_url}`)).map((r: any) => ({ kind: "d" as const, id: r.id, name: r.name, sub: `${RESTREAM_PRESETS[r.platform as RestreamPlatform]?.label ?? r.platform} · key ${r.key_hint}` })),
        ...(savedWeb.data?.sites ?? []).filter((s: any) => !inStudio.has(`w|${s.name}|${s.endpoint}`)).map((s: any) => ({ kind: "w" as const, id: s.id, name: s.name, sub: `${new URL(s.endpoint).host} · key …${s.keyHint}` })),
      ]
    : [];

  async function useSaved(p: { kind: "d" | "w"; id: string; name: string }) {
    if (!roomId) return;
    setBusy(true);
    try {
      if (p.kind === "d") await copy({ data: { roomId, savedId: p.id } });
      else await copyWeb({ data: { roomId, savedId: p.id } });
      toast.success(`${p.name} added to this studio.`);
      refresh();
    } catch (err) { toast.error(msg(err)); } finally { setBusy(false); }
  }

  async function applyNow() {
    setBusy(true);
    try {
      const r = await apply({ data: scoped });
      toast.success(r.count ? `Your live channel will now also go to ${r.count} other site${r.count > 1 ? "s" : ""}.` : "Extra destinations removed from your live channel.");
    } catch (err) { toast.error(msg(err)); } finally { setBusy(false); }
  }

  const loading = dest.isLoading;
  return (
    <div className={compact ? "space-y-2.5" : "space-y-4"}>
      <div className={cn("flex items-center gap-2", compact ? "justify-end" : "flex-wrap justify-between gap-3")}>
        {!compact && (
          <p className="text-sm text-muted-foreground">
            {roomId ? "Where this studio sends its show, on top of streamTXC." : "Your saved destinations. Add them to any studio, and they're used when you stream from OBS or StreamYard."}
          </p>
        )}
        <Button size={compact ? "sm" : "default"} onClick={() => setOpen(true)} disabled={rows.length + sites.length >= max * 2}
          className={cn("font-mono gap-1.5", compact && "w-full")}>
          <Plus className="h-4 w-4" /> Add destination
        </Button>
      </div>

      {roomId && pickable.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-xs text-primary">{compact ? "[ FROM SAVED ]" : "[ FROM MY SAVED DESTINATIONS ]"}</div>
          <div className={cn("flex flex-wrap", compact ? "gap-1.5" : "gap-2")}>
            {pickable.map((p) => (
              <Button key={`${p.kind}${p.id}`} variant="outline" size="sm" disabled={busy} onClick={() => useSaved(p)}
                className={cn("gap-1.5", compact && "h-7 max-w-full px-2 text-[11px]")} title={p.sub}>
                {p.kind === "w" ? <Globe className="h-3.5 w-3.5" /> : <Radio className="h-3.5 w-3.5" />} <Plus className="h-3 w-3" /> {p.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="font-mono text-sm text-muted-foreground">Loading…</div>
      ) : rows.length + sites.length === 0 ? (
        <p className={cn("text-muted-foreground border border-dashed border-border rounded-sm", compact ? "p-2 text-xs" : "p-4 text-sm")}>
          {roomId ? "No destinations in this studio yet — it goes to streamTXC only." : "No saved destinations yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-sm">
          {sites.map((s: any) => (
            <li key={s.id} className={cn("flex items-center gap-2", compact ? "p-2" : "gap-3 p-3")}>
              <Globe className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className={cn("truncate font-medium", compact && "text-[13px]")}>{s.name}</div>
                <div className={cn("font-mono text-muted-foreground truncate", compact ? "text-[11px]" : "text-xs")}>
                  {new URL(s.endpoint).host} · key …{s.keyHint} · {s.showing ? "showing now" : s.enabled ? "on" : "off"}
                  {s.problem && s.enabled ? " · couldn't reach it" : ""}
                </div>
              </div>
              <Switch checked={s.enabled} aria-label={`Show my live stream on ${s.name}`} onCheckedChange={async (v) => {
                try { await toggleWeb({ data: { id: s.id, enabled: v } }); refresh(); } catch (err) { toast.error(msg(err)); }
              }} />
              <Button variant="ghost" size="icon" aria-label={`Remove ${s.name}`} onClick={async () => {
                try { await delWeb({ data: { id: s.id } }); refresh(); } catch (err) { toast.error(msg(err)); }
              }}><Trash2 className="h-4 w-4" /></Button>
            </li>
          ))}
          {rows.map((r: any) => (
            <li key={r.id} className={cn("flex items-center gap-2", compact ? "p-2" : "gap-3 p-3")}>
              <Radio className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className={cn("truncate font-medium", compact && "text-[13px]")}>{r.name}</div>
                <div className={cn("font-mono text-muted-foreground truncate", compact ? "text-[11px]" : "text-xs")}>{RESTREAM_PRESETS[r.platform as RestreamPlatform]?.label ?? r.platform} · key {r.key_hint}</div>
              </div>
              <Switch checked={r.enabled} aria-label={`Send to ${r.name}`} onCheckedChange={async (v) => {
                try { await save({ data: { ...scoped, id: r.id, name: r.name, platform: r.platform, serverUrl: r.server_url, enabled: v } }); refresh(); }
                catch (err) { toast.error(msg(err)); }
              }} />
              <Button variant="ghost" size="icon" aria-label={`Remove ${r.name}`} onClick={async () => { await del({ data: { id: r.id } }); refresh(); }}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className={cn("flex gap-3", compact ? "flex-col items-stretch gap-1.5" : "flex-wrap items-center")}>
        <Button variant="outline" size={compact ? "sm" : "default"} onClick={applyNow} disabled={busy}
          className={cn("font-mono gap-2", compact && "w-full")}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Update my live channel
        </Button>
        <span className="text-xs text-muted-foreground">
          {compact ? "Channel off only · takes effect on next Go Live." : "Only works while your live channel is fully off. Changes take effect on your next Go Live."}
        </span>
      </div>

      <AddDestinationDialog
        open={open} onOpenChange={setOpen} roomId={roomId}
        onSaved={refresh}
        saveDest={(d) => save({ data: d })} saveWeb={(d) => saveWeb({ data: d })}
      />
    </div>
  );
}

function AddDestinationDialog({ open, onOpenChange, roomId, onSaved, saveDest, saveWeb }: {
  open: boolean; onOpenChange: (v: boolean) => void; roomId?: string; onSaved: () => void;
  saveDest: (d: any) => Promise<unknown>; saveWeb: (d: any) => Promise<unknown>;
}) {
  const [platform, setPlatform] = useState<RestreamPlatform | "website">("youtube");
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [streamKey, setStreamKey] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const isWeb = platform === "website";
  const preset = isWeb ? { label: "Website", help: "Get the address and key from the website's owner." } : RESTREAM_PRESETS[platform];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const base = isWeb
        ? { name: name || "Website", endpoint: serverUrl, key: streamKey }
        : { name: name || preset.label, platform, serverUrl: serverUrl || undefined, streamKey };
      const run = (extra: object) => (isWeb ? saveWeb({ ...base, ...extra }) : saveDest({ ...base, ...extra }));
      if (roomId) await run({ roomId });
      if (!roomId || keep) await run({});
      toast.success(roomId ? (keep ? "Added to this studio and saved to your destinations." : "Added to this studio.") : "Saved to your destinations.");
      onSaved();
      setName(""); setServerUrl(""); setStreamKey("");
      onOpenChange(false);
    } catch (err) { toast.error(msg(err)); } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a destination</DialogTitle>
          <DialogDescription>{roomId ? "Send this studio's show somewhere else too." : "Save a place you stream to, so you can add it to any studio."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ad-platform">Site</Label>
            <select id="ad-platform" value={platform} onChange={(e) => setPlatform(e.target.value as RestreamPlatform | "website")}
              className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm">
              {(Object.keys(RESTREAM_PRESETS) as RestreamPlatform[]).map((p) => <option key={p} value={p}>{RESTREAM_PRESETS[p].label}</option>)}
              <option value="website">Website (Honest.Money, TEXITcoin.org…)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ad-name">Name</Label>
            <Input id="ad-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${preset.label} channel`} maxLength={60} />
          </div>
          {(platform === "custom" || isWeb) && (
            <div className="space-y-1.5">
              <Label htmlFor="ad-url">{isWeb ? "Website address" : "Server URL"}</Label>
              <Input id="ad-url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder={isWeb ? "https://honest.money/api/public/streamtxc-live" : "rtmp://… or rtmps://…"} required />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ad-key">{isWeb ? "Key" : "Stream key"}</Label>
            <Input id="ad-key" type="password" autoComplete="off" value={streamKey} onChange={(e) => setStreamKey(e.target.value)} required />
            <p className="text-xs text-muted-foreground">{preset.help} We store it locked and only show the last 4 characters.</p>
          </div>
          {roomId && (
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox checked={keep} onCheckedChange={(v) => setKeep(v === true)} /> Save this to my destinations
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy} className="font-mono gap-2">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
