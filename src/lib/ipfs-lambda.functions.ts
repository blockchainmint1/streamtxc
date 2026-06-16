// Server functions wrapping the self-hosted IPFS pinning Lambda
// (POST /pin, POST /pin-by-hash). Lambda streams S3 objects into the
// kubo node at IPFS_API and returns the resulting wrap-dir CID plus a
// per-file manifest (inner file CIDs match locally-computed v1 CIDs
// since the Lambda uses cid-version=1 + raw-leaves=true).
//
// Configured by the txc-ipfs-deploy-v3.sh stack. Two env vars:
//   IPFS_LAMBDA_URL    https://<api-id>.execute-api.<region>.amazonaws.com
//   IPFS_LAMBDA_TOKEN  bearer token printed by the deploy script

import { createServerFn } from "@tanstack/react-start";

export interface PinManifestEntry {
  path: string;
  cid: string;
  size: number;
}

export interface PinFromS3Result {
  /** Wrap directory CID returned by `ipfs add --wrap-with-directory`. */
  wrapCid: string;
  /** Inner file CID. For single-file pins this is the canonical CID
   *  that matches the locally computed v1 CID. For multi-file pins
   *  this is the first manifest entry — callers usually want wrapCid. */
  fileCid: string | null;
  files: number;
  totalBytes: number;
  manifest: PinManifestEntry[];
  /** Round-trip duration in ms measured on the server. */
  durationMs: number;
}

export const isIpfsLambdaConfigured = createServerFn({ method: "GET" }).handler(
  async () => ({
    configured: Boolean(process.env.IPFS_LAMBDA_URL && process.env.IPFS_LAMBDA_TOKEN),
    gateway: process.env.IPFS_GATEWAY_DOMAIN ?? null,
  }),
);

/**
 * Ask the Lambda to stream one or more S3 objects into our self-hosted
 * IPFS node. Either `keys` (explicit list) or `prefix` (list under a
 * prefix) must be provided. The Lambda always wraps the upload in a
 * directory, so `wrapCid` is the directory CID and `manifest[i].cid` are
 * the inner file CIDs.
 */
export const pinS3ToIpfs = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { bucket?: string; prefix?: string; keys?: string[] }) => {
      if (d.bucket && d.bucket.length > 200) throw new Error("Invalid bucket");
      if (d.prefix && d.prefix.length > 500) throw new Error("Invalid prefix");
      if (d.keys && (!Array.isArray(d.keys) || d.keys.length > 10_000)) {
        throw new Error("Invalid keys");
      }
      return d;
    },
  )
  .handler(async ({ data }): Promise<PinFromS3Result> => {
    const url = process.env.IPFS_LAMBDA_URL;
    const token = process.env.IPFS_LAMBDA_TOKEN;
    if (!url || !token) throw new Error("IPFS Lambda not configured");
    const bucket = data.bucket || process.env.AWS_S3_INPUT_BUCKET;
    if (!bucket) throw new Error("bucket required (no AWS_S3_INPUT_BUCKET default)");

    const t0 = Date.now();
    const res = await fetch(`${url.replace(/\/$/, "")}/pin`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bucket,
        prefix: data.prefix,
        keys: data.keys,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`IPFS Lambda /pin failed [${res.status}]: ${text.slice(0, 500)}`);
    }
    let json: {
      cid?: string;
      files?: number;
      totalBytes?: number;
      manifest?: PinManifestEntry[];
    };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`IPFS Lambda /pin returned non-JSON: ${text.slice(0, 200)}`);
    }
    const manifest = Array.isArray(json.manifest) ? json.manifest : [];
    return {
      wrapCid: json.cid ?? "",
      fileCid: manifest[0]?.cid ?? null,
      files: json.files ?? manifest.length,
      totalBytes: json.totalBytes ?? 0,
      manifest,
      durationMs: Date.now() - t0,
    };
  });

/**
 * Health probe — calls `GET /health` on the Lambda. Useful to surface
 * "node not reachable" in the UI before kicking off a long upload.
 */
export const ipfsLambdaHealth = createServerFn({ method: "GET" }).handler(
  async () => {
    const url = process.env.IPFS_LAMBDA_URL;
    if (!url) return { ok: false, reason: "IPFS_LAMBDA_URL not set" };
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`);
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
);