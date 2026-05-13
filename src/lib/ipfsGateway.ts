// Server-side IPFS gateway helpers.
//
// Centralizes the list of gateways we read from, with sensible defaults and
// support for env overrides (comma-separated list or single URL). Provides
// path-style URL building plus fetch-with-fallback so callers can survive a
// flaky local node or an unreachable public gateway.

const DEFAULT_GATEWAYS = [
  "https://ipfs.blockchainmint.com",
  "https://gateway.pinata.cloud",
  "https://ipfs.io",
];

function normalize(g: string): string {
  return g.trim().replace(/\/+$/, "");
}

/** Resolve the ordered list of gateway base URLs to try. */
export function getIpfsGateways(): string[] {
  const raw =
    process.env.IPFS_GATEWAY_URLS ??
    process.env.VITE_IPFS_GATEWAY_URLS ??
    process.env.IPFS_GATEWAY_URL ??
    process.env.VITE_IPFS_GATEWAY_URL ??
    "";
  const parsed = raw
    .split(",")
    .map(normalize)
    .filter((g) => g.length > 0 && /^https?:\/\//i.test(g));

  // Always append the defaults as additional fallbacks (deduped).
  const merged = [...parsed, ...DEFAULT_GATEWAYS.map(normalize)];
  return Array.from(new Set(merged));
}

/**
 * Build a path-style gateway URL: `{gateway}/ipfs/{cid}[/{path}]`.
 * We never use subdomain-style gateways (broken for localhost / 127.0.0.1
 * and inconsistent across providers).
 */
export function buildIpfsUrl(gateway: string, cid: string, path = ""): string {
  const base = normalize(gateway);
  const trimmedPath = path.replace(/^\/+/, "");
  return trimmedPath
    ? `${base}/ipfs/${cid}/${trimmedPath}`
    : `${base}/ipfs/${cid}`;
}

const RETRYABLE_STATUS = new Set([404, 408, 429, 500, 502, 503, 504]);

/**
 * Fetch a CID through the configured gateways in order. Returns the first
 * response that is OK (or a non-retryable error). If every gateway fails
 * (network error, timeout, or retryable status), returns null.
 */
export async function fetchIpfsWithFallback(
  cid: string,
  init: RequestInit & { path?: string; perGatewayTimeoutMs?: number } = {},
): Promise<{ response: Response; gateway: string } | null> {
  const { path = "", perGatewayTimeoutMs = 10_000, ...fetchInit } = init;
  const gateways = getIpfsGateways();
  let lastErr: unknown = null;

  for (const gw of gateways) {
    const url = buildIpfsUrl(gw, cid, path);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), perGatewayTimeoutMs);
    try {
      const res = await fetch(url, { ...fetchInit, signal: ctl.signal });
      if (res.ok) return { response: res, gateway: gw };
      if (!RETRYABLE_STATUS.has(res.status)) {
        // Non-retryable (e.g. 416 range not satisfiable) — return as-is.
        return { response: res, gateway: gw };
      }
      // Drain & try next.
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      lastErr = new Error(`Gateway ${gw} returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(t);
    }
  }

  if (lastErr) console.warn("All IPFS gateways failed:", lastErr);
  return null;
}

/**
 * HEAD then small-Range GET probe across all gateways. Returns whatever
 * size / content-type info we could extract; size may be null if the
 * gateway didn't expose it.
 */
export async function probeCidViaGateways(
  cid: string,
  perGatewayTimeoutMs = 10_000,
): Promise<{
  found: boolean;
  sizeBytes: number | null;
  mimeType: string | null;
  gateway: string | null;
  error: string | null;
}> {
  const gateways = getIpfsGateways();
  let lastErr: string | null = null;

  for (const gw of gateways) {
    const url = buildIpfsUrl(gw, cid);
    try {
      // HEAD first.
      let res = await timedFetch(url, { method: "HEAD" }, perGatewayTimeoutMs);
      let size = parseSize(res);
      let mime = res.headers.get("content-type");

      // Some gateways (including kubo's local 8080) don't expose useful
      // headers on HEAD — fall back to a 1-byte Range GET.
      if (!res.ok || (size == null && !mime)) {
        res = await timedFetch(
          url,
          { method: "GET", headers: { Range: "bytes=0-0" } },
          perGatewayTimeoutMs,
        );
        size = parseSize(res) ?? size;
        mime = res.headers.get("content-type") ?? mime;
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
      }

      if (res.ok || res.status === 206) {
        return {
          found: true,
          sizeBytes: size,
          mimeType: mime,
          gateway: gw,
          error: null,
        };
      }
      lastErr = `Gateway ${gw} returned ${res.status}`;
    } catch (err) {
      lastErr =
        err instanceof Error
          ? err.name === "AbortError"
            ? `Gateway ${gw} timed out`
            : err.message
          : `Gateway ${gw} failed`;
    }
  }

  return {
    found: false,
    sizeBytes: null,
    mimeType: null,
    gateway: null,
    error: lastErr,
  };
}

function parseSize(res: Response): number | null {
  const range = res.headers.get("content-range");
  if (range) {
    const total = range.split("/")[1];
    const n = total ? Number(total) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  const len = res.headers.get("content-length");
  if (len) {
    const n = Number(len);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}