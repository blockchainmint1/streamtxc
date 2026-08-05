// IPFS pin client (server-only).
//
// Strategy: self-hosted IPFS node (the kubo behind IPFS_GATEWAY_DOMAIN) is
// the PRIMARY home for every CID we create. Pinata is a best-effort BACKUP
// — we ping its pinByHash API after the primary succeeds, but failures are
// swallowed and logged. If the self-node is unreachable the caller sees a
// hard error.
//
// Two transports into the self-node, both via the IPFS Lambda:
//   - POST /add      multipart/form-data → kubo /api/v0/add  (for arbitrary bytes:
//                    thumbnails, JSON, comments, chain stamps, small directories)
//   - POST /pin      streams S3 objects → kubo /api/v0/add   (for big bundles
//                    like HLS ladders — see ipfs-lambda.functions.ts)

const PINATA_API = "https://api.pinata.cloud/v3";
const PINATA_LEGACY = "https://api.pinata.cloud";
const PINATA_UPLOADS = "https://uploads.pinata.cloud/v3";

export interface PinResult {
  cid: string;
  size: number;
  /** Legacy Pinata file id. Empty string in the self-node-primary path. */
  pinataId: string;
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

/**
 * Fire-and-forget Pinata backup pin. NEVER throws — failures are logged.
 * Runs `pinByHash` against the CID we just wrote to the self-node so the
 * same bytes also live in our Pinata account.
 */
async function backupPinToPinata(cid: string, name?: string): Promise<void> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    console.log(`pinata-backup: skipping ${cid} (PINATA_JWT not configured)`);
    return;
  }
  try {
    const res = await fetch(`${PINATA_LEGACY}/pinning/pinByHash`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hashToPin: cid,
        pinataMetadata: { name: name ?? cid },
      }),
    });
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => "");
      console.warn(
        `pinata-backup: pinByHash ${cid} soft-fail [${res.status}] ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn(`pinata-backup: pinByHash ${cid} threw`, err);
  }
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
 * Pin a single file to IPFS. Self-node primary; Pinata backup best-effort.
 */
export async function pinFileToIPFS(
  file: Blob | File,
  filename: string,
): Promise<PinResult> {
  const form = new FormData();
  // Single-file add — no wrap. The returned root CID is the file CID.
  form.append("file", file, filename);
  const primary = await addToSelfNode(form, { wrap: false, name: filename });
  // Background backup — don't await; we don't want a slow Pinata to block
  // upload latency, and we never want a Pinata failure to break the call.
  void backupPinToPinata(primary.cid, filename);
  return { cid: primary.cid, size: primary.size || file.size, pinataId: "" };
}

/**
 * Pin a directory of files as a single wrap-directory CID. Self-node
 * primary; Pinata backup best-effort. Each entry's `path` becomes the
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
  void backupPinToPinata(primary.cid, dirName);
  return { cid: primary.cid, size: primary.size || totalSize, pinataId: "" };
}

/**
 * Pin a small JSON object. Self-node primary; Pinata backup best-effort.
 */
export async function pinJsonToIPFS(
  obj: unknown,
  filename: string,
): Promise<PinResult> {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  return pinFileToIPFS(blob, filename);
}

/**
 * Legacy: presigned Pinata upload URL for the browser-direct upload path.
 * Only used by the old `getUploadUrl` server function in videos.functions.ts
 * (kept as a fallback for the original Upload flow before the S3 +
 * MediaConvert pipeline took over). New code should not call this.
 */
export async function createPresignedUploadUrl(opts: {
  filename: string;
  expiresSeconds?: number;
}): Promise<{ url: string; expires: number }> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not configured");

  const expires = opts.expiresSeconds ?? 60 * 60; // 1 hour
  const res = await fetch(`${PINATA_UPLOADS}/files/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      network: "public",
      expires,
      filename: opts.filename,
      date: Math.floor(Date.now() / 1000),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata sign failed [${res.status}]: ${text}`);
  }

  const json = (await res.json()) as { data: string };
  return { url: json.data, expires };
}

/**
 * Pin an already-existing CID. Self-node first (mirrors via kubo /pin/add
 * over the IPFS swarm); Pinata backup best-effort. Used to mirror old
 * Pinata-only CIDs into our self-node and vice-versa.
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

  // Backup: also pin in Pinata (best-effort, never throws).
  await backupPinToPinata(cid, name);
}

export function gatewayUrl(cid: string): string {
  // Prefer our self-hosted IPFS node when configured; fall back to Pinata.
  const ownNode = process.env.IPFS_GATEWAY_DOMAIN;
  if (ownNode) return `https://${ownNode}/ipfs/${cid}`;
  const pinata = process.env.PINATA_GATEWAY_DOMAIN;
  if (pinata) return `https://${pinata}/ipfs/${cid}`;
  return `https://gateway.pinata.cloud/ipfs/${cid}`;
}

/**
 * Pinata-only gateway URL — used as the fallback target by `/api/stream/*`
 * when the self-hosted node can't serve a CID. Skips `IPFS_GATEWAY_DOMAIN`
 * even when it's set; that's the whole point of the fallback.
 */
export function pinataGatewayUrl(cid: string): string {
  const pinata = process.env.PINATA_GATEWAY_DOMAIN;
  if (pinata) return `https://${pinata}/ipfs/${cid}`;
  return `https://gateway.pinata.cloud/ipfs/${cid}`;
}

/**
 * Resolve the best gateway for a CID right now. Tries the self-hosted node
 * first with a short HEAD probe; falls back to Pinata on miss/timeout so a
 * not-yet-mirrored CID never leaves the UI broken. Returned URL is what
 * `/api/stream/*` should 302 to.
 *
 * Keep the timeout tight — this runs on every stream redirect.
 */
const gatewayProbeCache = new Map<string, { url: string; expires: number }>();

/**
 * Domain-level circuit breaker for the self-hosted node.
 *
 * Per-CID memoization isn't enough when the node itself is unreachable
 * (bad DNS, box down, SG change): every *new* CID still pays the full
 * probe timeout, so a page of thumbnails or an HLS segment burst stalls
 * for seconds each. After a few consecutive failures we stop probing
 * entirely and go straight to Pinata, retrying the node occasionally.
 */
const selfNode = { fails: 0, openUntil: 0 };
const SELF_NODE_FAIL_THRESHOLD = 3;
const SELF_NODE_OPEN_MS = 60_000;

export async function resolveGatewayUrl(
  cid: string,
  timeoutMs = 800,
): Promise<string> {
  const ownNode = process.env.IPFS_GATEWAY_DOMAIN;
  if (!ownNode) return pinataGatewayUrl(cid);
  const selfUrl = `https://${ownNode}/ipfs/${cid}`;
  // Short-lived memo so a page full of thumbnails (or a segment burst)
  // doesn't re-probe the same CID dozens of times within one isolate.
  const cached = gatewayProbeCache.get(cid);
  if (cached && cached.expires > Date.now()) return cached.url;
  // Breaker open: the node is known-bad right now, don't pay the timeout.
  if (selfNode.openUntil > Date.now()) return pinataGatewayUrl(cid);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // `redirect: "manual"` so a directory CID's 301 (kubo appends a trailing
    // slash for UnixFS dirs) is visible to us instead of being followed.
    const res = await fetch(selfUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: ctrl.signal,
    });
    // Anything under 400 means the node HAS the content: 200 for files,
    // 301/302 for directory CIDs (HLS bundles). Treating a 3xx as a miss
    // sent every HLS master to Pinata, which doesn't hold our self-pinned
    // bundles — the "does not have this content pinned" playback failure.
    if (res.status < 400) {
      selfNode.fails = 0;
      gatewayProbeCache.set(cid, { url: selfUrl, expires: Date.now() + 300_000 });
      return selfUrl;
    }
    // A 404 means the node is alive but doesn't have this CID — that's a
    // per-CID miss, not a node outage, so it must not trip the breaker.
    if (res.status >= 500) selfNode.fails += 1;
    else selfNode.fails = 0;
  } catch {
    // network error / abort — the node itself looks unreachable
    selfNode.fails += 1;
  } finally {
    clearTimeout(t);
  }
  if (selfNode.fails >= SELF_NODE_FAIL_THRESHOLD) {
    selfNode.openUntil = Date.now() + SELF_NODE_OPEN_MS;
    selfNode.fails = 0;
    console.warn(
      `resolveGatewayUrl: self-hosted node ${ownNode} unreachable — serving from Pinata for ${SELF_NODE_OPEN_MS / 1000}s`,
    );
  }
  const fallback = pinataGatewayUrl(cid);
  gatewayProbeCache.set(cid, { url: fallback, expires: Date.now() + 60_000 });
  return fallback;
}

/**
 * HEAD-probe the gateway for a CID. Returns true if the bytes are
 * fetchable right now (200 OK). Short timeout so we never block the UI
 * on a slow gateway. Best-effort — a `false` doesn't strictly prove the
 * CID is gone from IPFS as a whole, only that our gateway can't serve
 * it within the timeout window.
 */
export function selfNodeGatewayUrl(cid: string): string | null {
  const ownNode = process.env.IPFS_GATEWAY_DOMAIN;
  return ownNode ? `https://${ownNode}/ipfs/${cid}` : null;
}

/** Drop a memoized gateway choice for a CID (used after a failed fetch). */
export function invalidateGatewayProbe(cid: string): void {
  gatewayProbeCache.delete(cid);
}

/**
 * Fetch `<gateway>/<cid>/<path>` with an automatic cross-gateway retry.
 *
 * The HEAD probe in `resolveGatewayUrl` is only a hint: under load (or with
 * the breaker briefly open) it can pick Pinata for a bundle that only exists
 * on the self-hosted node — or vice-versa. A single miss then surfaced as a
 * hard 502 and dead playback. Here we always try the other gateway before
 * giving up, and invalidate the bad memo so later requests re-probe.
 */
export async function fetchThroughGateways(
  cid: string,
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; base: string } | null> {
  const suffix = path ? `/${path.replace(/^\/+/, "")}` : "";
  const primary = await resolveGatewayUrl(cid);
  const self = selfNodeGatewayUrl(cid);
  const pinata = pinataGatewayUrl(cid);
  const candidates = [primary, primary === self ? pinata : self, pinata].filter(
    (u, i, a): u is string => !!u && a.indexOf(u) === i,
  );
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}${suffix}`, init);
      if (res.ok) {
        if (base !== primary) invalidateGatewayProbe(cid);
        return { res, base };
      }
    } catch {
      // try the next gateway
    }
  }
  invalidateGatewayProbe(cid);
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
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Best-effort unpin. Looks up the file by CID in our Pinata account, then
 * deletes it. Used by the payment watcher when a video's 24h grace expires
 * without funds landing.
 */
export async function unpinByCid(cid: string): Promise<boolean> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return false;
  try {
    const lookup = await fetch(
      `${PINATA_API}/files/public?cid=${encodeURIComponent(cid)}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    if (!lookup.ok) return false;
    const data = (await lookup.json()) as { data?: { files?: { id: string }[] } };
    const files = data.data?.files ?? [];
    let ok = false;
    for (const f of files) {
      const del = await fetch(`${PINATA_API}/files/public/${f.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (del.ok) ok = true;
    }
    return ok;
  } catch (err) {
    console.warn("unpinByCid failed", err);
    return false;
  }
}