// Studio layouts: where each on-stage person (and an optional shared screen)
// goes on the 16:9 program picture. Pure so it can be tested.
export type StudioLayout = "solo" | "split" | "grid" | "screen";
export const STUDIO_LAYOUTS: { id: StudioLayout; label: string }[] = [
  { id: "solo", label: "Solo" },
  { id: "split", label: "Side by side" },
  { id: "grid", label: "Grid" },
  { id: "screen", label: "Screen + cams" },
];
export interface Rect { x: number; y: number; w: number; h: number }

export function layoutRects(layout: StudioLayout, people: number, hasScreen: boolean, W: number, H: number, gap = 12) {
  const slots: Rect[] = [];
  let screenRect: Rect | null = null;
  if (hasScreen && (layout === "screen" || people === 0)) {
    const side = people ? Math.round(W * 0.24) : 0;
    screenRect = { x: gap, y: gap, w: W - side - gap * (people ? 3 : 2), h: H - gap * 2 };
    const n = Math.min(people, 4);
    const h = n ? (H - gap * (n + 1)) / n : 0;
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
