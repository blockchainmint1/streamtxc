// Plain, self-contained email bodies for every app email (sent via Amazon SES).
// All user-supplied values are HTML-escaped before they enter the markup.
type Data = Record<string, unknown>;
const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (v: unknown) => {
  try { const u = new URL(String(v)); return u.protocol === "https:" ? u.toString() : ""; } catch { return ""; }
};

const ORANGE = "#ff7a1a";
const INK = "#12151c";
const MONO = "'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace";
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const SITE = "https://streamtxc.com";

type Tone = "info" | "warn" | "alert" | "live";
const TONES: Record<Tone, { tag: string; color: string }> = {
  info: { tag: "ACCOUNT", color: ORANGE },
  warn: { tag: "HEADS UP", color: "#f5b301" },
  alert: { tag: "ACTION NEEDED", color: "#ff4d4f" },
  live: { tag: "● LIVE", color: "#ff3b3b" },
};

function shell(
  heading: string,
  paras: string[],
  cta?: { label: string; url: unknown },
  opts: { tone?: Tone; preview?: string; rows?: [string, string][] } = {},
) {
  const tone = TONES[opts.tone ?? "info"];
  const url = cta ? safeUrl(cta.url) : "";
  const btn = url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px"><tr><td style="background:${ORANGE};border-radius:6px">
<a href="${esc(url)}" style="display:inline-block;padding:14px 26px;font-family:${MONO};font-size:14px;font-weight:700;color:${INK};text-decoration:none;letter-spacing:.5px">${esc(cta!.label)} &rarr;</a></td></tr></table>
<p style="margin:0;font-size:12px;color:#8a8f98;font-family:${SANS}">Button not working? Paste this link: <a href="${esc(url)}" style="color:${ORANGE};word-break:break-all">${esc(url)}</a></p>`
    : "";
  const rows = (opts.rows ?? []).length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #e6e8ec;border-radius:6px">${opts.rows!
        .map(([k, v], i) => `<tr><td style="padding:10px 14px;font-family:${MONO};font-size:11px;color:#8a8f98;text-transform:uppercase;letter-spacing:1px;${i ? "border-top:1px solid #e6e8ec;" : ""}">${esc(k)}</td><td style="padding:10px 14px;font-family:${SANS};font-size:14px;color:${INK};text-align:right;${i ? "border-top:1px solid #e6e8ec;" : ""}">${esc(v)}</td></tr>`)
        .join("")}</table>`
    : "";
  const foot = (l: string, h: string) => `<a href="${SITE}${h}" style="color:#8a8f98;text-decoration:underline">${l}</a>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preview ?? heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:${INK};border-radius:10px 10px 0 0;padding:22px 28px;border-bottom:3px solid ${ORANGE}">
<span style="font-family:${MONO};font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-.5px">stream<span style="color:${ORANGE}">TXC</span></span>
<span style="float:right;font-family:${MONO};font-size:11px;font-weight:700;color:${tone.color};letter-spacing:1.5px;line-height:28px">[ ${tone.tag} ]</span></td></tr>
<tr><td style="border:1px solid #e6e8ec;border-top:0;border-radius:0 0 10px 10px;padding:32px 28px">
<h1 style="margin:0 0 16px;font-family:${SANS};font-size:24px;line-height:1.25;color:${INK}">${esc(heading)}</h1>
${paras.map((p) => `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.6;color:#3a3f48">${p}</p>`).join("")}
${rows}${btn}</td></tr>
<tr><td style="padding:22px 8px;text-align:center;font-family:${SANS};font-size:12px;line-height:1.7;color:#8a8f98">
Decentralized video on TEXITcoin &amp; IPFS &middot; part of the <a href="https://honest.money" style="color:${ORANGE};text-decoration:none;font-weight:600">honest.money</a> ecosystem<br>
${foot("Manage alerts", "/manage?tab=alerts")} &middot; ${foot("Terms", "/terms")} &middot; ${foot("Privacy", "/privacy")} &middot; ${foot("Manifesto", "/manifesto")}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    "streamTXC",
    heading,
    ...paras.map((p) => p.replace(/<[^>]+>/g, "")),
    ...(opts.rows ?? []).map(([k, v]) => `${k}: ${v}`),
    url ? `${cta!.label}: ${url}` : "",
    "—\nPart of the honest.money ecosystem. Manage alerts: " + SITE + "/manage?tab=alerts",
  ].filter(Boolean).join("\n\n");
  return { html, text };
}

const when = (v: unknown) => {
  const d = new Date(String(v ?? ""));
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const short = (v: unknown) => String(v ?? "").slice(0, 80);
const rowsOf = (r: [string, string][]) => r.filter(([, v]) => v);

export function renderAppEmail(name: string, d: Data): { subject: string; html: string; text: string } | null {
  const title = esc(d.title || "your video");
  const days = Number(d.daysLeft) || 0;
  switch (name) {
    case "wallet-verify-email":
      return { subject: "Confirm your email for streamTXC alerts", ...shell("One tap to confirm your email",
        ["You asked to get streamTXC alerts at this address — renewal reminders, expiry notices and live-stream heads-ups.",
         "Confirm it's really you and we'll start sending. The link works for 24 hours.",
         `<span style="color:#8a8f98;font-size:13px">Didn't ask for this? Ignore this email and nothing changes.</span>`],
        { label: "Confirm my email", url: d.verifyLink }, { tone: "info", preview: "Confirm this address to start getting streamTXC alerts." }) };
    case "video-expiry-warning":
      return { subject: `⏳ ${days} day${days === 1 ? "" : "s"} left: "${short(d.title) || "Your video"}"`, ...shell(`${days} day${days === 1 ? "" : "s"} left on your video`,
        [`<b>${title}</b> is paid up for ${days} more day${days === 1 ? "" : "s"}. Top it up with TXC and it stays pinned, playable and on-chain.`],
        { label: "Renew with TXC", url: d.manageUrl },
        { tone: days <= 1 ? "alert" : "warn", preview: `Renew "${short(d.title)}" to keep it online.`, rows: rowsOf([["Video", short(d.title)], ["Expires", when(d.expiresAt)]]) }) };
    case "video-expiring":
      return { subject: `⚠️ "${short(d.title) || "Your video"}" has expired — renew to keep it`, ...shell("Your video has expired",
        [`<b>${title}</b> ran out of hosting. It's still safe for now, but it will be unpinned unless you renew.`],
        { label: "Renew now", url: d.manageUrl },
        { tone: "alert", preview: "Renew now before it's unpinned.", rows: rowsOf([["Video", short(d.title)], ["Unpins after", when(d.unpinAfter)]]) }) };
    case "video-unpinned":
      return { subject: `"${short(d.title) || "Your video"}" was taken offline`, ...shell("Your video was taken offline",
        [`<b>${title}</b> was unpinned after its hosting ran out.`,
         "Good news: you can still bring it back from your Manage page for a limited time — renew and it's restored."],
        { label: "Restore my video", url: d.manageUrl }, { tone: "alert", preview: "You can still restore it for a limited time.", rows: rowsOf([["Video", short(d.title)]]) }) };
    case "live-stream-starting":
      return { subject: `🔴 Live now: ${short(d.title) || "streamTXC"}`, ...shell("We're live!",
        [`<b>${title}</b> just went live on streamTXC. Jump in while it's happening.`],
        { label: "Watch live", url: d.url }, { tone: "live", preview: `${short(d.title)} is live now.` }) };
    default:
      return null;
  }
}
