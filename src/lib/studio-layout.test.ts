import { describe, expect, test } from "bun:test";
import { layoutRects } from "./studio-layout";

describe("studio layouts", () => {
  test("solo shows one person, side-by-side two, grid up to nine", () => {
    expect(layoutRects("solo", 3, false, 1280, 720).slots.length).toBe(1);
    expect(layoutRects("split", 3, false, 1280, 720).slots.length).toBe(2);
    expect(layoutRects("grid", 12, false, 1280, 720).slots.length).toBe(9);
  });
  test("screen layout gives the screen the big area and up to 4 cams on the side", () => {
    const r = layoutRects("screen", 6, true, 1280, 720);
    expect(r.screenRect).not.toBeNull();
    expect(r.slots.length).toBe(4);
    for (const s of r.slots) expect(s.x).toBeGreaterThan(r.screenRect!.x + r.screenRect!.w);
  });
  test("every slot stays inside the picture", () => {
    for (const s of layoutRects("grid", 5, false, 1280, 720).slots) {
      expect(s.x + s.w).toBeLessThanOrEqual(1280); expect(s.y + s.h).toBeLessThanOrEqual(720);
    }
  });
});

describe("screen share modes", () => {
  test("split gives the screen half the picture and the cams the other half", () => {
    const r = layoutRects("grid", 1, true, 1280, 720, 12, "split");
    expect(r.screenRect!.w).toBe(r.slots[0]!.w);
    expect(r.slots[0]!.x).toBeGreaterThan(r.screenRect!.w);
  });
  test("bubble follows the dragged position and never leaves the picture", () => {
    const r = layoutRects("grid", 1, true, 1280, 720, 12, "pip", { x: 0.1, y: 0.1 });
    expect(r.slots[0]!.x).toBe(128);
    const far = layoutRects("grid", 1, true, 1280, 720, 12, "pip", { x: 5, y: 5 }).slots[0]!;
    expect(far.x + far.w).toBeLessThanOrEqual(1280); expect(far.y + far.h).toBeLessThanOrEqual(720);
  });
  test("screen only hides the cams", () => {
    expect(layoutRects("grid", 3, true, 1280, 720, 12, "full").slots.length).toBe(0);
  });
});
