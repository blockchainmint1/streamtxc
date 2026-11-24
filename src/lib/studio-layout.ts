// Studio layouts: where each on-stage person (and an optional shared screen)
// goes on the 16:9 program picture. Pure so it can be tested.
export type StudioLayout = "solo" | "split" | "grid" | "screen";
export const STUDIO_LAYOUTS: { id: StudioLayout; label: string }[] = [
  { id: "solo", label: "Solo" },
  { id: "split", label: "Side by side" },
  { id: "grid", label: "Grid" },
  { id: "screen", label: "Screen + cams" },
];
/** How cameras sit next to a shared screen. */
export type ScreenMode = "side" | "split" | "pip" | "full";
export const SCREEN_MODES: { id: ScreenMode; label: string }[] = [
  { id: "side", label: "Cams on side" },
  { id: "split", label: "Split 50/50" },
  { id: "pip", label: "Bubble (drag me)" },
  { id: "full", label: "Screen only" },
];
export interface Rect { x: number; y: number; w: number; h: number }
/** Top-left of the bubble group, as 0–1 fractions of the picture. */
export interface PipPos { x: number; y: number }
export const DEFAULT_PIP: PipPos = { x: 0.76, y: 0.68 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function layoutRects(
  layout: StudioLayout, people: number, hasScreen: boolean, W: number, H: number, gap = 12,
  screenMode: ScreenMode = "side", pip: PipPos = DEFAULT_PIP,
) {
  const slots: Rect[] = [];
  let screenRect: Rect | null = null;
  if (hasScreen) {
    if (screenMode === "full" || !people) {
      return { screenRect: { x: gap, y: gap, w: W - gap * 2, h: H - gap * 2 }, slots };
    }
    if (screenMode === "split") {
      const half = (W - gap * 3) / 2;
      screenRect = { x: gap, y: gap, w: half, h: H - gap * 2 };
      const n = Math.min(people, 2);
      const h = (H - gap * (n + 1)) / n;
      for (let i = 0; i < n; i++) slots.push({ x: gap * 2 + half, y: gap + i * (h + gap), w: half, h });
      return { screenRect, slots };
    }
    if (screenMode === "pip") {
      screenRect = { x: 0, y: 0, w: W, h: H };
      const n = Math.min(people, 3);
      const w = Math.round(W * 0.22), h = Math.round((w * 9) / 16);
      const total = n * h + (n - 1) * gap;
      const x0 = clamp(pip.x * W, gap, W - w - gap);
      const y0 = clamp(pip.y * H, gap, Math.max(gap, H - total - gap));
      for (let i = 0; i < n; i++) slots.push({ x: x0, y: y0 + i * (h + gap), w, h });
      return { screenRect, slots };
    }
    const side = Math.round(W * 0.24);
    screenRect = { x: gap, y: gap, w: W - side - gap * 3, h: H - gap * 2 };
    const n = Math.min(people, 4);
    const h = (H - gap * (n + 1)) / n;
    for (let i = 0; i < n; i++) slots.push({ x: W - side - gap, y: gap + i * (h + gap), w: side, h });
    return { screenRect, slots };
  }
  const n = layout === "solo" ? Math.min(people, 1) : layout === "split" ? Math.min(people, 2) : Math.min(people, 9);
  if (!n) return { screenRect, slots };
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const w = (W - gap * (cols + 1)) / cols;
  const h = (H - gap * (rows + 1)) / rows;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const inRow = Math.min(cols, n - r * cols);
    const offset = ((cols - inRow) * (w + gap)) / 2;
    slots.push({ x: gap + offset + c * (w + gap), y: gap + r * (h + gap), w, h });
  }
  return { screenRect, slots };
}
