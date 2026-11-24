// Creator studio: the host picks who is on stage, a layout and branding; the
// browser paints the finished picture on a canvas and shares it into the
// meeting as "content". The live connector uses the presenter-only layout,
// so whatever this canvas shows is exactly what the live stream shows.
import { STUDIO_TOPIC, type StudioSignal } from "@/lib/green-room";
import { useEffect, useRef, useState } from "react";
import { MonitorUp, Radio, Square, ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { STUDIO_LAYOUTS, layoutRects, type StudioLayout } from "@/lib/studio-layout";

export interface StudioPerson { attendeeId: string; name: string; tileId?: number; isSelf: boolean }

interface Branding {
  layout: StudioLayout; color: string; logo: string | null; showNames: boolean;
  banner: string; showBanner: boolean; ticker: string; showTicker: boolean;
}
const W = 1280, H = 720;
const DEFAULTS: Branding = {
  layout: "grid", color: "#e8a33d", logo: null, showNames: true, banner: "", showBanner: false, ticker: "", showTicker: false,
};

function useBranding(code: string) {
  const key = `studio:${code}`;
  const [b, setB] = useState<Branding>(DEFAULTS);
  useEffect(() => {
    try { const raw = localStorage.getItem(key); if (raw) setB({ ...DEFAULTS, ...JSON.parse(raw) }); } catch { /* ignore */ }
  }, [key]);
  const update = (p: Partial<Branding>) => setB((prev) => {
    const next = { ...prev, ...p };
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { toast.error("That logo is too big to remember — try a smaller image."); }
    return next;
  });
  return [b, update] as const;
}

function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, x: number, y: number, w: number, h: number, contain = false, mirror = false) {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return false;
  const s = contain ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
  const dw = vw * s, dh = vh * s;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh); }
  else ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
  return true;
}

export function StudioPanel({
  av, code, people, localSharing, othersSharing,
}: { av: any; code: string; people: StudioPerson[]; localSharing: boolean; othersSharing: boolean }) {
  const [b, setB] = useBranding(code);
  const [stage, setStage] = useState<string[]>([]);
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const [onAir, setOnAir] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const vids = useRef(new Map<string, HTMLVideoElement>());
  const screenVid = useRef<HTMLVideoElement | null>(null);
  const logoImg = useRef<HTMLImageElement | null>(null);
  const tickerX = useRef(W);
  const state = useRef({ b, stage, people, screen });
  state.current = { b, stage, people, screen };

  // Drop people who left from the stage.
  useEffect(() => {
    setStage((s) => s.filter((id) => people.some((p) => p.attendeeId === id)));
  }, [people]);

  useEffect(() => {
    if (!b.logo) { logoImg.current = null; return; }
    const img = new Image(); img.src = b.logo; img.onload = () => { logoImg.current = img; };
  }, [b.logo]);

  useEffect(() => {
    if (screenVid.current) screenVid.current.srcObject = screen;
    if (!screen) return;
    const t = screen.getVideoTracks()[0];
    const end = () => setScreen(null);
    t?.addEventListener("ended", end);
    return () => t?.removeEventListener("ended", end);
  }, [screen]);

  // Paint loop (timer, not rAF, so it keeps going when the tab isn't focused as long as possible).
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const t = setInterval(() => {
      const { b, stage, people, screen } = state.current;
      ctx.fillStyle = "#101114"; ctx.fillRect(0, 0, W, H);
      const onStage = stage.map((id) => people.find((p) => p.attendeeId === id)).filter(Boolean) as StudioPerson[];
      const reserve = (b.showBanner && b.banner ? 70 : 0) + (b.showTicker && b.ticker ? 40 : 0);
      const { screenRect, slots } = layoutRects(b.layout, onStage.length, !!screen, W, H - reserve);
      if (screenRect && screenVid.current) drawCover(ctx, screenVid.current, screenRect.x, screenRect.y, screenRect.w, screenRect.h, true);
      onStage.forEach((p, i) => {
        const r = slots[i]; if (!r) return;
        ctx.fillStyle = "#1c1e24"; ctx.fillRect(r.x, r.y, r.w, r.h);
        const v = vids.current.get(p.attendeeId);
        const drew = v && p.tileId ? drawCover(ctx, v, r.x, r.y, r.w, r.h, false, p.isSelf) : false;
        if (!drew) {
          ctx.fillStyle = b.color; ctx.beginPath();
          ctx.arc(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) / 6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#101114"; ctx.font = `bold ${Math.round(Math.min(r.w, r.h) / 6)}px system-ui`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(p.name.charAt(0).toUpperCase(), r.x + r.w / 2, r.y + r.h / 2);
        }
        if (b.showNames) {
          ctx.font = "600 22px system-ui"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          const tw = ctx.measureText(p.name).width + 28;
          ctx.fillStyle = b.color; ctx.fillRect(r.x + 12, r.y + r.h - 48, tw, 36);
          ctx.fillStyle = "#101114"; ctx.fillText(p.name, r.x + 26, r.y + r.h - 30);
        }
      });
      if (!onStage.length && !screenRect) {
        ctx.fillStyle = "#8a8f98"; ctx.font = "500 28px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("Starting soon", W / 2, (H - reserve) / 2);
      }
      let y = H - reserve;
      if (b.showBanner && b.banner) {
        ctx.fillStyle = b.color; ctx.fillRect(0, y, W, 70);
        ctx.fillStyle = "#101114"; ctx.font = "700 30px system-ui"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(b.banner, 28, y + 35, W - 56); y += 70;
      }
      if (b.showTicker && b.ticker) {
        ctx.fillStyle = "#000000"; ctx.fillRect(0, y, W, 40);
        ctx.fillStyle = "#ffffff"; ctx.font = "500 22px system-ui"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(b.ticker).width;
        tickerX.current -= 3; if (tickerX.current < -tw) tickerX.current = W;
        ctx.fillText(b.ticker, tickerX.current, y + 20);
      }
      const logo = logoImg.current;
      if (logo) {
        const lh = 72, lw = (logo.width / logo.height) * lh;
        ctx.drawImage(logo, W - lw - 24, 20, lw, lh);
      }
    }, 1000 / 30);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { if (!localSharing) setOnAir(false); }, [localSharing]);

  // Green room: tell guests who's on stage (repeated so late joiners hear it).
  const sendSignal = (sig: StudioSignal) => { try { av?.realtimeSendDataMessage(STUDIO_TOPIC, JSON.stringify(sig), 10_000); } catch { /* noop */ } };
  useEffect(() => {
    const sig = { onAir, stage };
    sendSignal(sig);
    const t = setInterval(() => sendSignal(sig), 5000);
    return () => clearInterval(t);
  }, [onAir, stage, av]);
  useEffect(() => () => sendSignal({ onAir: false, stage: [] }), [av]);
  const cue = (id: string, name: string) => { sendSignal({ onAir, stage, cue: id }); toast.success(`Told ${name} to get ready.`); };

  async function goOnAir() {
    const c = canvasRef.current; if (!c || !av) return;
    try {
      await av.startContentShare(c.captureStream(30));
      setOnAir(true);
      toast.success("Studio picture is on. Use “Send to live stream” to broadcast it.");
    } catch { toast.error("Couldn't start the studio picture."); }
  }
  function offAir() { try { av?.stopContentShare(); } catch { /* noop */ } setOnAir(false); }
  async function addScreen() {
    try { setScreen(await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })); }
    catch { /* cancelled */ }
  }
  function pickLogo(f: File | undefined) {
    if (!f) return;
    if (f.size > 400_000) { toast.error("Use a logo under 400 KB."); return; }
    const r = new FileReader(); r.onload = () => setB({ logo: String(r.result) }); r.readAsDataURL(f);
  }
  const toggleStage = (id: string) => setStage((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 grid gap-3 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3 min-w-0">
        <div className="relative rounded-sm border border-border overflow-hidden bg-card">
          <canvas ref={canvasRef} width={W} height={H} className="w-full h-auto block" aria-label="Studio program picture" />
          {onAir && <span className="absolute left-2 top-2 rounded-sm bg-destructive px-2 py-0.5 font-mono text-xs font-bold text-destructive-foreground">● ON AIR</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          {onAir ? (
            <Button variant="destructive" onClick={offAir} className="font-mono gap-2"><Square className="h-4 w-4" /> Stop studio picture</Button>
          ) : (
            <Button onClick={goOnAir} disabled={othersSharing} className="font-mono gap-2"><Radio className="h-4 w-4" /> Put studio on air</Button>
          )}
          {screen ? (
            <Button variant="outline" onClick={() => { screen.getTracks().forEach((t) => t.stop()); setScreen(null); }} className="font-mono gap-2"><X className="h-4 w-4" /> Remove screen</Button>
          ) : (
            <Button variant="outline" onClick={addScreen} className="font-mono gap-2"><MonitorUp className="h-4 w-4" /> Add a screen</Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Keep this tab open and in front while live — browsers slow down hidden tabs.
          {othersSharing ? " Someone is sharing their screen; stop that first." : ""}
        </p>
        <div>
          <div className="font-mono text-xs text-primary mb-2">[ GREEN ROOM · click to put on stage ]</div>
          {onAir && <p className="text-xs text-muted-foreground mb-2">Guests not on stage are muted for the audience and see a "you're backstage" notice.</p>}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {people.map((p) => (
              <button
                key={p.attendeeId} type="button" onClick={() => toggleStage(p.attendeeId)}
                className={cn("relative shrink-0 w-40 aspect-video rounded-sm border overflow-hidden bg-card text-left",
                  stage.includes(p.attendeeId) ? "border-primary ring-2 ring-primary" : "border-border")}
                aria-pressed={stage.includes(p.attendeeId)}
              >
                {p.tileId ? (
                  <BoundVideo av={av} tileId={p.tileId} mirror={p.isSelf} onEl={(el) => { if (el) vids.current.set(p.attendeeId, el); else vids.current.delete(p.attendeeId); }} />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-xl font-bold">{p.name.charAt(0).toUpperCase()}</span>
                )}
                <span className="absolute bottom-1 left-1 rounded-sm bg-background/80 px-1.5 font-mono text-[11px]">
                  {stage.includes(p.attendeeId) ? "● " : ""}{p.name}
                </span>
                {!p.isSelf && !stage.includes(p.attendeeId) && (
                  <span
                    role="button" tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); cue(p.attendeeId, p.name); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); cue(p.attendeeId, p.name); } }}
                    className="absolute top-1 right-1 rounded-sm bg-primary px-1.5 font-mono text-[10px] font-bold text-primary-foreground"
                  >cue</span>
                )}
              </button>
            ))}
            <video ref={screenVid} autoPlay playsInline muted className={cn("shrink-0 w-40 aspect-video rounded-sm border border-border bg-card", !screen && "hidden")} />
          </div>
        </div>
      </div>

      <aside className="space-y-4 border border-border rounded-sm p-4 bg-card h-fit">
        <div>
          <Label className="mb-2 block">Layout</Label>
          <div className="grid grid-cols-2 gap-2">
            {STUDIO_LAYOUTS.map((l) => (
              <Button key={l.id} type="button" size="sm" variant={b.layout === l.id ? "default" : "outline"} onClick={() => setB({ layout: l.id })} className="font-mono text-xs">
                {l.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between"><Label htmlFor="st-names">Name tags</Label><Switch id="st-names" checked={b.showNames} onCheckedChange={(v) => setB({ showNames: v })} /></div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between"><Label htmlFor="st-banner">Banner</Label><Switch aria-label="Show banner" checked={b.showBanner} onCheckedChange={(v) => setB({ showBanner: v })} /></div>
          <Input id="st-banner" value={b.banner} maxLength={90} onChange={(e) => setB({ banner: e.target.value })} placeholder="Daily Executive Meeting" />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between"><Label htmlFor="st-ticker">Scrolling ticker</Label><Switch aria-label="Show ticker" checked={b.showTicker} onCheckedChange={(v) => setB({ showTicker: v })} /></div>
          <Input id="st-ticker" value={b.ticker} maxLength={240} onChange={(e) => setB({ ticker: e.target.value })} placeholder="Get TXC at swap.texitcoin.org" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="st-color">Brand color</Label>
          <input id="st-color" type="color" value={b.color} onChange={(e) => setB({ color: e.target.value })} className="h-8 w-14 rounded-sm border border-border bg-background" />
        </div>
        <div className="space-y-1.5">
          <Label>Logo</Label>
          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-sm border border-border px-3 py-1.5 text-sm hover:border-primary">
              <ImagePlus className="h-4 w-4" /> {b.logo ? "Change" : "Upload"}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => pickLogo(e.target.files?.[0])} />
            </label>
            {b.logo && <Button size="sm" variant="ghost" onClick={() => setB({ logo: null })}>Remove</Button>}
          </div>
        </div>
      </aside>
    </div>
  );
}

function BoundVideo({ av, tileId, mirror, onEl }: { av: any; tileId: number; mirror?: boolean; onEl: (el: HTMLVideoElement | null) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!av || !ref.current) return;
    av.bindVideoElement(tileId, ref.current);
    onEl(ref.current);
    return () => { onEl(null); try { av.unbindVideoElement(tileId, false); } catch { /* gone */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [av, tileId]);
  return <video ref={ref} autoPlay playsInline muted className={cn("absolute inset-0 h-full w-full object-cover", mirror && "-scale-x-100")} />;
}
