// Green room: while the studio is on air, guests who are not on stage wait
// backstage with their mic held muted so the audience can't hear them.
export const STUDIO_TOPIC = "studio";

export type StudioSignal = { onAir: boolean; stage: string[]; cue?: string };
export type GuestSpot = "meeting" | "backstage" | "on-stage";

export function parseStudioSignal(text: string): StudioSignal | null {
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null || typeof v.onAir !== "boolean" || !Array.isArray(v.stage)) return null;
    const stage = v.stage.filter((x: unknown): x is string => typeof x === "string").slice(0, 50);
    return typeof v.cue === "string" ? { onAir: v.onAir, stage, cue: v.cue } : { onAir: v.onAir, stage };
  } catch { return null; }
}

/** The host is never held backstage; everyone else is, unless on stage, while on air. */
export function guestSpot(sig: StudioSignal | null, selfId: string, isHost: boolean): GuestSpot {
  if (isHost || !sig || !sig.onAir) return "meeting";
  return sig.stage.includes(selfId) ? "on-stage" : "backstage";
}
