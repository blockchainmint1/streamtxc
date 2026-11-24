// Plain, self-contained email bodies for every app email (sent via Amazon SES).
// All user-supplied values are HTML-escaped before they enter the markup.
type Data = Record<string, unknown>;
const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (v: unknown) => {
  try { const u = new URL(String(v)); return u.protocol === "https:" ? u.toString() : ""; } catch { return ""; }
};

function shell(heading: string, paras: string[], cta?: { label: string; url: unknown }) {
  const url = cta ? safeUrl(cta.url) : "";
  const btn = url
    ? `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#e8a33d;color:#111;padding:12px 20px;border-radius:4px;text-decoration:none;font-weight:bold">${esc(cta!.label)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="background:#ffffff;font-family:Arial,sans-serif;color:#111;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto"><div style="font-weight:bold;color:#e8a33d;letter-spacing:1px">streamTXC</div>
<h1 style="font-size:20px">${esc(heading)}</h1>${paras.map((p) => `<p style="line-height:1.5">${p}</p>`).join("")}${btn}
<p style="font-size:12px;color:#666;margin-top:32px">streamTXC — part of the <a href="https://honest.money" style="color:#666">honest.money</a> ecosystem.</p></div></body></html>`;
  const text = [heading, ...paras.map((p) => p.replace(/<[^>]+>/g, "")), url ? `${cta!.label}: ${url}` : ""].filter(Boolean).join("\n\n");
  return { html, text };
}

export function renderAppEmail(name: string, d: Data): { subject: string; html: string; text: string } | null {
  const title = esc(d.title || "your video");
  switch (name) {
    case "wallet-verify-email":
      return { subject: "Confirm your email for streamTXC alerts", ...shell("Confirm your email",
        ["Tap the button to confirm this address for streamTXC alerts. The link works for 24 hours.", "If you didn't ask for this, ignore this email."],
        { label: "Confirm email", url: d.verifyLink }) };
    case "video-expiry-warning":
      return { subject: `"${String(d.title ?? "Your video").slice(0, 80)}" expires in ${Number(d.daysLeft) || 0} day(s)`, ...shell("Your video is expiring soon",
        [`<b>${title}</b> expires in ${Number(d.daysLeft) || 0} day(s). Renew it to keep it online.`], { label: "Renew now", url: d.manageUrl }) };
    case "video-expiring":
      return { subject: `"${String(d.title ?? "Your video").slice(0, 80)}" has expired — renew to keep it`, ...shell("Your video has expired",
        [`<b>${title}</b> has expired. It will be removed unless you renew it soon.`], { label: "Renew now", url: d.manageUrl }) };
    case "video-unpinned":
      return { subject: `"${String(d.title ?? "Your video").slice(0, 80)}" was removed`, ...shell("Your video was removed",
        [`<b>${title}</b> was taken offline after its hosting ran out. You can still restore it from your Manage page for a limited time.`], { label: "Open Manage", url: d.manageUrl }) };
    case "live-stream-starting":
      return { subject: `Live now: ${String(d.title ?? "streamTXC").slice(0, 80)}`, ...shell("A stream is starting",
        [`<b>${title}</b> is going live.`], { label: "Watch", url: d.url }) };
    default:
      return null;
  }
}
