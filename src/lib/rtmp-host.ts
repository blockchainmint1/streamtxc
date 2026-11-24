/** Friendly name for the main live channel's AWS ingest address (plain RTMP only). */
export const FRIENDLY_RTMP_HOST = "live.streamtxc.com";

/** Swap the raw IP in an rtmp:// URL for the friendly name when DNS says they match. */
export function prettifyRtmpUrl(url: string, resolvedIps: string[], friendly = FRIENDLY_RTMP_HOST): string {
  const m = url.match(/^rtmp:\/\/(\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/.*)?$/i);
  if (!m || !resolvedIps.includes(m[1]!)) return url;
  return `rtmp://${friendly}${m[2] ?? ""}${m[3] ?? ""}`;
}

/** Look up the friendly name's current addresses; empty on any failure so the raw IP is shown. */
export async function resolveFriendlyHost(friendly = FRIENDLY_RTMP_HOST): Promise<string[]> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${friendly}&type=A`, {
      headers: { accept: "application/dns-json" },
      redirect: "manual",
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}
