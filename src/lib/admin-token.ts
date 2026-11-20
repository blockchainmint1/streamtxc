// Constant-time comparison for the operator password used by admin and cron endpoints.
export function secretMatches(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected || typeof provided !== "string") return false;
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
