// Self-hosted IPFS client (server-only).
//
// Two transports into the self-node, both via the IPFS Lambda:
//   - POST /add      multipart/form-data → kubo /api/v0/add  (for arbitrary bytes:
//                    thumbnails, JSON, comments, chain stamps, small directories)
//   - POST /pin      streams S3 objects → kubo /api/v0/add   (for big bundles
//                    like HLS ladders — see ipfs-lambda.functions.ts)

import { mediaResponseHeaders } from "./media-security";

export interface PinResult {
  cid: string;
  size: number;
}

function lambdaConfig(): { url: string; token: string } {
  const url = process.env.IPFS_LAMBDA_URL;
  const token = process.env.IPFS_LAMBDA_TOKEN;
  if (!url || !token) {
    throw new Error(
      "IPFS_LAMBDA_URL / IPFS_LAMBDA_TOKEN missing — self-hosted IPFS node is unreachable",
    );
  }
  return { url: url.replace(/\/$/, ""), token };
}

interface AddResponse {
  cid?: string;
  files?: number;
  totalBytes?: number;
  manifest?: Array<{ path: string; cid: string; size: number }>;
}

/**
 * Stream a multipart FormData into kubo via the Lambda's POST /add route.
 * Returns the root CID. When `wrap` is true, kubo wraps the parts in a
 * directory and the root CID is the directory CID.
 */
async function addToSelfNode(
  form: FormData,
  opts: { wrap: boolean; name: string },
): Promise<{ cid: string; size: number }> {
  const { url, token } = lambdaConfig();
  const q = opts.wrap ? "?wrap=1" : "";
  const res = await fetch(`${url}/add${q}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Self-node /add failed [${res.status}] for ${opts.name}: ${text.slice(0, 400)}`,
    );
  }
  const json = (await res.json()) as AddResponse;
  if (!json.cid) {
    throw new Error(`Self-node /add returned no cid for ${opts.name}`);
  }
  return { cid: json.cid, size: json.totalBytes ?? 0 };
}

/**
 * Pin a single file to the self-hosted IPFS node.
 */
export async function pinFileToIPFS(
  file: Blob | File,
  filename: string,
): Promise<PinResult> {
  const form = new FormData();
  // Single-file add — no wrap. The returned root CID is the file CID.
  form.append("file", file, filename);
  const writeKey = process.env.IPFS_WRITE_KEY;
  if (writeKey && file.size <= 95 * 1024 * 1024) {
    const res = await fetch("https://ipfs.honest.money/api/public/v1/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${writeKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`IPFS upload failed [${res.status}]`);
    const result = (await res.json()) as PinResult;
    if (!result.cid) throw new Error("IPFS upload returned no CID");
    return { cid: result.cid, size: result.size ?? file.size };
  }
  const primary = await addToSelfNode(form, { wrap: false, name: filename });
  return { cid: primary.cid, size: primary.size || file.size };
}

/**
 * Pin a directory of files as a single wrap-directory CID. Each entry's `path` becomes the
 * relative path inside the wrap dir, e.g. `720p/index.m3u8`.
 *
 * NOTE: API Gateway has a 10 MB request-body cap. For large directories
 * (HLS bundles), prefer the S3 → Lambda /pin path
 * (see `kickHlsPinAsync` in ipfs-lambda.functions.ts) instead of this.
 */
export async function pinDirectoryToIPFS(
  files: Array<{ path: string; body: Blob | Uint8Array; contentType?: string }>,
  dirName: string,
): Promise<PinResult> {
  if (files.length === 0) throw new Error("pinDirectoryToIPFS: no files");
  const form = new FormData();
  let totalSize = 0;
  for (const f of files) {
    const blob =
      f.body instanceof Blob
        ? f.body
        : new Blob([f.body as BlobPart], {
            type: f.contentType ?? "application/octet-stream",
          });
    totalSize += blob.size;
    const cleanPath = f.path.replace(/^\/+/, "");
    // Kubo /add with wrap-with-directory uses the part filenames as
    // relative paths inside the resulting directory.
    form.append("file", blob, cleanPath);
  }
  const primary = await addToSelfNode(form, { wrap: true, name: dirName });
  return { cid: primary.cid, size: primary.size || totalSize };
}

/**
 * Pin a small JSON object.
 */
export async function pinJsonToIPFS(
  obj: unknown,
  filename: string,
): Promise<PinResult> {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  return pinFileToIPFS(blob, filename);
}

/**
 * Pin an already-existing CID on the self-hosted node via kubo /pin/add.
 */
export async function pinByCid(cid: string, name?: string): Promise<void> {
  // Primary: tell our kubo to fetch the CID from the IPFS swarm.
  try {
    const { url, token } = lambdaConfig();
    const res = await fetch(`${url}/pin-cid`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cid, name: name ?? cid }),
    });
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => "");
      console.warn(
        `pinByCid: self-node /pin-cid soft-fail [${res.status}] for ${cid}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`pinByCid: self-node /pin-cid threw for ${cid}`, err);
  }

}

/**
 * Public links use our media endpoint, never a credential-bearing URL.
 */
export function withGatewayKey(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname.replace(/^\/ipfs\//, "/api/stream/");
}

/** Authenticate only server-to-node reads, preserving range and accept headers. */
export async function fetchGateway(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const key = process.env.IPFS_READ_KEY;
  if (key) headers.set("Authorization", `Bearer ${key}`);
  // Cloudflare Workers reject redirect: "error" (only "follow"/"manual" are
  // supported), which made every published media request fail. "manual"
  // still never follows a redirect, so the key can't leak to another host;
  // callers treat a 3xx as unavailable.
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  if (res.status >= 300 && res.status < 400 && res.status !== 304) {
    return new Response(null, { status: 502 });
  }
  return res;
}

/** Stream bytes without forwarding upstream credentials, cookies or redirects. */
export async function serveGateway(url: string, request: Request, cacheControl: string): Promise<Response> {
  const headers = new Headers();
  for (const name of ["range", "accept", "if-none-match", "if-modified-since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetchGateway(url, { headers });
    if (!upstream.ok && upstream.status !== 304) return new Response("Media unavailable", { status: 502 });
    const outgoing = mediaResponseHeaders(upstream.headers.get("content-type"), new URL(url).pathname);
    outgoing.set("cache-control", cacheControl);
    outgoing.set("access-control-allow-origin", "*");
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    return new Response(upstream.status === 304 ? null : upstream.body, { status: upstream.status, headers: outgoing });
  } catch {
    return new Response("Media unavailable", { status: 502 });
  }
}

export function gatewayUrl(cid: string): string {
  const ownNode = process.env.IPFS_GATEWAY_DOMAIN || "node.ipfs.honest.money";
  return `https://${ownNode}/ipfs/${cid}`;
}

/**
 * Return the sole configured gateway. Availability checks must not redirect
 * to third-party gateways because they do not necessarily host our CIDs.
 */
export async function resolveGatewayUrl(
  cid: string,
  _timeoutMs = 800,
): Promise<string> {
  return gatewayUrl(cid);
}

/**
 * HEAD-probe the gateway for a CID. Returns true if the bytes are
 * fetchable right now (200 OK). Short timeout so we never block the UI
 * on a slow gateway. Best-effort — a `false` doesn't strictly prove the
 * CID is gone from IPFS as a whole, only that our gateway can't serve
 * it within the timeout window.
 */
export function selfNodeGatewayUrl(cid: string): string | null {
  return gatewayUrl(cid);
}

/**
 * Fetch `<gateway>/<cid>/<path>` from the self-hosted gateway.
 */
export async function fetchThroughGateways(
  cid: string,
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; base: string } | null> {
  const suffix = path ? `/${path.replace(/^\/+/, "")}` : "";
  const base = gatewayUrl(cid);
  try {
    const res = await fetchGateway(`${base}${suffix}`, init);
    if (res.ok) return { res, base };
  } catch {
    // Report unavailable to the caller.
  }
  return null;
}

export async function headCidOnGateway(
  cid: string,
  timeoutMs = 4000,
): Promise<boolean> {
  const url = gatewayUrl(cid);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchGateway(url, { method: "HEAD", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Best-effort unpin from the self-hosted node.
 */
export async function unpinByCid(cid: string): Promise<boolean> {
  try {
    const { url, token } = lambdaConfig();
    const res = await fetch(`${url}/unpin-cid`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cid }),
    });
    return res.ok;
  } catch (err) {
    console.warn("unpinByCid failed", err);
    return false;
  }
}