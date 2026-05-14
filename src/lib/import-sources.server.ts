// URL → direct-download resolvers for the "Import from URL" feature.
//
// Each resolver returns the direct streaming URL plus enough metadata to
// build a progress bar (filename, size). The streaming endpoint then opens
// `fetch(directUrl)` and pipes the body into Pinata.
//
// Adding a new source = add a host to `HOST_ALLOWLIST` and wire one
// resolver function below.

export type ImportSource = "wetransfer" | "dropbox" | "google-drive";

export interface ResolvedImport {
  source: ImportSource;
  directUrl: string;
  filename: string;
  sizeBytes: number | null;
  /** Optional headers to send when fetching the directUrl (cookies, etc). */
  fetchHeaders?: Record<string, string>;
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const HOST_ALLOWLIST = [
  "wetransfer.com",
  "we.tl",
  "dropbox.com",
  "www.dropbox.com",
  "dl.dropboxusercontent.com",
  "drive.google.com",
  "docs.google.com",
];

export async function resolveImport(rawUrl: string): Promise<ResolvedImport> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!HOST_ALLOWLIST.includes(host)) {
    throw new Error(
      `Unsupported source "${host}". Currently we can import from WeTransfer or Dropbox.`,
    );
  }

  if (host.endsWith("wetransfer.com") || host === "we.tl") {
    return resolveWeTransfer(parsed);
  }
  if (host.endsWith("dropbox.com") || host === "dl.dropboxusercontent.com") {
    return resolveDropbox(parsed);
  }
  if (host === "drive.google.com" || host === "docs.google.com") {
    return resolveGoogleDrive(parsed);
  }
  throw new Error(`No resolver for ${host}`);
}

// --- WeTransfer ----------------------------------------------------------
//
// Public share links look like:
//   https://wetransfer.com/downloads/<transfer_id>/<security_hash>?...
//
// To get the actual file URL we:
//  1. GET the share page to harvest the CSRF token (`<meta name="csrf-token">`)
//     plus the session cookie WT issues.
//  2. POST to /api/v4/transfers/<transfer_id>/download with the security_hash
//     and `intent: "entire_transfer"`. Response: `{ direct_link: "..." }`.
//  3. HEAD the direct link to get Content-Length + filename.
//
// WeTransfer changes this internal API from time to time — when imports start
// failing with weird 4xx responses, this is the first thing to re-check.

async function resolveWeTransfer(url: URL): Promise<ResolvedImport> {
  // Short-link form `we.tl/t-XXX` 302s to the full /downloads/.../... URL.
  let pageUrl = url;
  if (url.hostname === "we.tl") {
    const head = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": UA },
    });
    const loc = head.headers.get("location");
    if (!loc) throw new Error("WeTransfer short link didn't redirect.");
    pageUrl = new URL(loc);
  }

  const m = pageUrl.pathname.match(/^\/downloads\/([^/]+)\/([^/]+)/);
  if (!m) {
    throw new Error(
      "WeTransfer URL must look like wetransfer.com/downloads/<id>/<hash>",
    );
  }
  const [, transferId, securityHash] = m;

  // 1. Scrape page for CSRF + cookie.
  const pageRes = await fetch(pageUrl.toString(), {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!pageRes.ok) {
    throw new Error(
      `WeTransfer page returned ${pageRes.status}. Link may be expired.`,
    );
  }
  const html = await pageRes.text();
  const csrf = html.match(
    /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i,
  )?.[1];
  if (!csrf) {
    throw new Error(
      "Couldn't extract WeTransfer CSRF token — their page format may have changed. Ping support.",
    );
  }
  const setCookie = pageRes.headers.get("set-cookie") ?? "";
  // Forward only the name=value pairs WT issued.
  const cookieHeader = setCookie
    .split(/,(?=[^ ;]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  // 2. Ask WT for the direct link.
  const apiRes = await fetch(
    `https://wetransfer.com/api/v4/transfers/${encodeURIComponent(transferId)}/download`,
    {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://wetransfer.com",
        Referer: pageUrl.toString(),
        "x-csrf-token": csrf,
        "x-requested-with": "XMLHttpRequest",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({
        security_hash: securityHash,
        intent: "entire_transfer",
      }),
    },
  );
  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => "");
    throw new Error(
      `WeTransfer API rejected the request (${apiRes.status}). The link may be expired or password-protected. ${text.slice(0, 200)}`,
    );
  }
  const apiJson = (await apiRes.json()) as {
    direct_link?: string;
    items?: unknown[];
  };
  const directUrl = apiJson.direct_link;
  if (!directUrl) {
    throw new Error(
      "WeTransfer didn't return a direct link. The transfer may be password-protected.",
    );
  }

  // 3. HEAD the direct URL for size + final filename.
  const head = await fetch(directUrl, { method: "HEAD" });
  if (!head.ok) {
    throw new Error(
      `WeTransfer direct link returned ${head.status} on HEAD probe.`,
    );
  }
  const sizeBytes = parseSize(head.headers.get("content-length"));
  const filename =
    parseFilenameFromContentDisposition(head.headers.get("content-disposition")) ||
    safeFilenameFromUrl(directUrl) ||
    `wetransfer-${transferId}.bin`;

  // If the transfer bundles >1 file, WT zips it. Most likely not playable.
  if (filename.toLowerCase().endsWith(".zip")) {
    throw new Error(
      "This WeTransfer link contains multiple files (a .zip). Send a single-file transfer so we can pin the video directly.",
    );
  }

  return {
    source: "wetransfer",
    directUrl,
    filename,
    sizeBytes,
  };
}

// --- Dropbox -------------------------------------------------------------
//
// Dropbox share links of the form
//   https://www.dropbox.com/s/<id>/<filename>?dl=0
//   https://www.dropbox.com/scl/fi/<id>/<filename>?rlkey=...&dl=0
// become direct downloads when `dl=1`. We follow redirects through to
// dl.dropboxusercontent.com which serves the bytes with Content-Length.

async function resolveDropbox(url: URL): Promise<ResolvedImport> {
  const direct = new URL(url.toString());
  // Force dl=1 so Dropbox serves the raw file rather than the share page.
  direct.searchParams.set("dl", "1");

  const head = await fetch(direct.toString(), {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": UA },
  });
  if (!head.ok) {
    throw new Error(
      `Dropbox returned ${head.status}. The link may be private or expired.`,
    );
  }

  const sizeBytes = parseSize(head.headers.get("content-length"));
  const filename =
    parseFilenameFromContentDisposition(head.headers.get("content-disposition")) ||
    safeFilenameFromUrl(direct.toString()) ||
    "dropbox-file.bin";

  return {
    source: "dropbox",
    directUrl: direct.toString(),
    filename,
    sizeBytes,
  };
}

// --- helpers -------------------------------------------------------------

function parseSize(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseFilenameFromContentDisposition(
  cd: string | null,
): string | null {
  if (!cd) return null;
  // Prefer RFC 5987 filename* if present (handles UTF-8).
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?["']?([^"';]+)["']?/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = cd.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  if (plain) return (plain[1] ?? plain[2] ?? "").trim() || null;
  return null;
}

function safeFilenameFromUrl(u: string): string | null {
  try {
    const url = new URL(u);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (!last) return null;
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}