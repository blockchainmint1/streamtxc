// Short meeting sounds made in the browser (no audio files to load).
// "join" = soft two-note chime when someone enters; "knock" = two taps when someone is waiting.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

function tone(ac: AudioContext, freq: number, start: number, length: number, volume: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

export function playMeetSound(kind: "join" | "knock") {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  if (kind === "join") {
    tone(ac, 660, t, 0.25, 0.12);
    tone(ac, 880, t + 0.15, 0.35, 0.12);
  } else {
    tone(ac, 420, t, 0.12, 0.18);
    tone(ac, 420, t + 0.18, 0.12, 0.18);
  }
}

const LOCAL_MUTE_KEY = "meet:sounds-muted";
export function soundsMutedLocally(): boolean {
  try { return window.localStorage.getItem(LOCAL_MUTE_KEY) === "1"; } catch { return false; }
}
export function setSoundsMutedLocally(muted: boolean) {
  try { window.localStorage.setItem(LOCAL_MUTE_KEY, muted ? "1" : "0"); } catch { /* private mode */ }
}
