// Zoom share-page resolver.
//
// Zoom recording share links (https://zoom.us/rec/share/<token>) render a
// player whose SSR HTML contains a signed CloudFront URL for the recording
// mp4 — Policy/Signature/Key-Pair-Id baked in. We pull that URL straight
// out of the HTML and hand it to the existing URL-import streamer, which
// pipes the bytes into Pinata.
//
// Passcode-protected shares: POST {id, passwd} to the share URL to set the
// `_zm_ssid` cookie, then refetch the HTML with that cookie.
//
// Login-walled shares (account/SSO-only) can't be resolved from a Worker —
// no headless browser available. We surface a clear error.

import type { ResolvedImport } from "./import-sources.server";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const MP4_RE =
  /https:\/\/ssrweb\.zoom\.us\/cmr\/replay\/[^"'\s<>]+?\.mp4\?[^"'\s<>]+?Signature=[^"'\s<>&]+/;

export async function resolveZoom(
  url: URL,
  passcode?: string,
): Promise<ResolvedImport> {
  const shareUrl = url.toString();

  // /rec/play/... is the *personal* playback URL Zoom shows the recording
  // owner while signed in — it's not a shareable link and we can't resolve
  // it server-side. Tell the user where to get the right URL.
  if (/\/rec\/play\//i.test(url.pathname)) {
    throw new Error(
      "That's a personal Zoom playback URL (/rec/play/...), which only works while you're signed in. Open the recording in Zoom, click \"Share\", and paste the /rec/share/... link instead.",
    );
  }

  // 1) Optionally unlock with passcode → harvest cookies.
  let cookieHeader = "";
  if (passcode) {
    const tokenMatch = url.pathname.match(/\/rec\/share\/([^/?]+)/);
    const recordingId = tokenMatch?.[1];
    if (!recordingId) {
      throw new Error("Couldn't parse Zoom share token from URL.");
    }
    const formBody = new URLSearchParams({ id: recordingId, passwd: passcode });
    const unlockRes = await fetch(shareUrl, {
      method: "POST",
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
      },
      body: formBody.toString(),
    });
    cookieHeader = collectSetCookies(unlockRes.headers);
    // Some Zoom regions return the player HTML directly from this POST.
    // Try to extract from it first to save a roundtrip.
    const html = await unlockRes.text();
    const direct = tryExtract(html, shareUrl);
    if (direct) return direct;
    if (/wrong passcode|incorrect/i.test(html)) {
      throw new Error("Zoom rejected the passcode for that share.");
    }
  }

  // 2) Fetch the share page HTML (with any cookies from step 1).
  const pageRes = await fetch(shareUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
  if (!pageRes.ok) {
    throw new Error(`Zoom returned ${pageRes.status} loading the share page.`);
  }
  const html = await pageRes.text();

  // Zoom returns the generic marketing homepage (HTTP 200) when a share
  // has expired, been deleted, or is restricted to a signed-in audience
  // outside the share token. Detect that and say so.
  const isGenericHome =
    /<title>[^<]*Video Conferencing[^<]*Zoom<\/title>/i.test(html) &&
    !MP4_RE.test(html);
  if (isGenericHome) {
    throw new Error(
      "Zoom didn't return a recording page for that link — the recording is likely expired, deleted, or restricted to signed-in viewers in your account. Open it in Zoom and confirm the share link is publicly accessible.",
    );
  }

  // Passcode wall detection — page is HTML 200 but shows the passcode form.
  if (
    !passcode &&
    /id="password"|name="passwd"|access_code|passcode_required/i.test(html) &&
    !MP4_RE.test(html)
  ) {
    throw new Error(
      "This Zoom recording is passcode-protected. Enter the passcode and try again.",
    );
  }
  // Login wall.
  if (
    /signin\/auth|account.+required|please sign in/i.test(html) &&
    !MP4_RE.test(html)
  ) {
    throw new Error(
      "This Zoom recording requires signing in to view — we can't import login-walled shares. Download it manually and use the regular upload tab.",
    );
  }

  const resolved = tryExtract(html, shareUrl);
  if (!resolved) {
    throw new Error(
      "Couldn't find a video URL on that Zoom share page. The recording may have expired or the page format changed.",
    );
  }
  return resolved;
}

function tryExtract(html: string, shareUrl: string): ResolvedImport | null {
  const m = html.match(MP4_RE);
  if (!m) return null;
  const directUrl = decodeHtmlEntities(m[0]);

  // Title — prefer og:title, fall back to <title>.
  const ogTitle = html.match(
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
  )?.[1];
  const docTitle = html.match(/<title>([^<]+)<\/title>/i)?.[1];
  const title = decodeHtmlEntities(
    (ogTitle || docTitle || "Zoom recording").trim(),
  );

  // Filename derived from the recording filename in the URL (e.g.
  // GMT20260617-235112_Recording_2560x1440.mp4) so the IPFS pin has a
  // meaningful name.
  let filename = "zoom-recording.mp4";
  try {
    const p = new URL(directUrl).pathname;
    const last = p.split("/").filter(Boolean).pop();
    if (last && /\.mp4$/i.test(last)) filename = last;
  } catch {
    /* keep default */
  }

  return {
    source: "zoom",
    directUrl,
    filename,
    sizeBytes: null, // Zoom's signed mp4 doesn't expose Content-Length on HEAD reliably; streaming endpoint reads it from upstream.
    fetchHeaders: {
      "User-Agent": UA,
      Referer: shareUrl,
    },
    suggestedTitle: title,
  };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function collectSetCookies(h: Headers): string {
  const sc = h.get("set-cookie") ?? "";
  return sc
    .split(/,(?=[^ ;]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}