// Pinata IPFS pinning client (server-only). Uses JWT auth.
// https://docs.pinata.cloud/api-reference/endpoint/upload-a-file

const PINATA_UPLOADS = "https://uploads.pinata.cloud/v3";
const PINATA_API = "https://api.pinata.cloud/v3";

export interface PinResult {
  cid: string;
  size: number;
  pinataId: string;
}

export async function pinFileToIPFS(
  file: Blob | File,
  filename: string,
): Promise<PinResult> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not configured");

  const form = new FormData();
  form.append("file", file, filename);
  form.append("network", "public");
  // Request CIDv1 (bafy…) instead of legacy CIDv0 (Qm…)
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const res = await fetch(`${PINATA_UPLOADS}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata upload failed [${res.status}]: ${text}`);
  }

  const json = (await res.json()) as {
    data: { id: string; cid: string; size: number };
  };
  return {
    cid: json.data.cid,
    size: json.data.size,
    pinataId: json.data.id,
  };
}

/**
 * Pin a small JSON object to IPFS. Returns the CID. Used to anchor
 * comment bodies so the chain only needs to carry the CID pointer.
 */
export async function pinJsonToIPFS(
  obj: unknown,
  filename: string,
): Promise<PinResult> {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  return pinFileToIPFS(blob, filename);
}

/**
 * Request a presigned URL the browser can POST a file to directly.
 * Avoids streaming large files through our Worker.
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
 * Pin an already-existing CID into our Pinata account so playback is reliable.
 * Returns the queue entry id; pinning happens asynchronously on Pinata's side.
 */
export async function pinByCid(cid: string, name?: string): Promise<void> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not configured");

  // Use the legacy v1 pinByHash endpoint — the v3 `files/public/pin_by_cid`
  // endpoint returns 400 for our account/payload shape, while pinByHash works
  // reliably and queues the CID for asynchronous pinning.
  const res = await fetch("https://api.pinata.cloud/pinning/pinByHash", {
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

  // 200/202 both acceptable; ignore "already pinned" style errors.
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => "");
    // Don't throw — pin_by_cid is best-effort. Just log.
    console.warn(`pin_by_cid soft-fail [${res.status}]: ${text}`);
  }
}

export function gatewayUrl(cid: string): string {
  const domain = process.env.PINATA_GATEWAY_DOMAIN;
  if (domain) return `https://${domain}/ipfs/${cid}`;
  return `https://gateway.pinata.cloud/ipfs/${cid}`;
}

/**
 * HEAD-probe the gateway for a CID. Returns true if the bytes are
 * fetchable right now (200 OK). Short timeout so we never block the UI
 * on a slow gateway. Best-effort — a `false` doesn't strictly prove the
 * CID is gone from IPFS as a whole, only that our gateway can't serve
 * it within the timeout window.
 */
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