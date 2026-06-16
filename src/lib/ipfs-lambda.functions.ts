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
    configured: Boolean(
      process.env.IPFS_LAMBDA_TOKEN &&
        (process.env.IPFS_LAMBDA_URL ||
          (process.env.IPFS_LAMBDA_NAME &&
            process.env.AWS_ACCESS_KEY_ID &&
            process.env.AWS_REGION)),
    ),
    gateway: process.env.IPFS_GATEWAY_DOMAIN ?? null,
    transport: process.env.IPFS_LAMBDA_NAME && process.env.AWS_ACCESS_KEY_ID
      ? "direct-invoke"
      : "api-gateway",
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
    const token = process.env.IPFS_LAMBDA_TOKEN;
    if (!token) throw new Error("IPFS_LAMBDA_TOKEN missing");
    const bucket = data.bucket || process.env.AWS_S3_INPUT_BUCKET;
    if (!bucket) throw new Error("bucket required (no AWS_S3_INPUT_BUCKET default)");

    const t0 = Date.now();
    const payload = {
      bucket,
      prefix: data.prefix,
      keys: data.keys,
    };
    const json = await callPinLambda(payload, token);
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
 * Shared transport: prefer direct AWS Lambda Invoke (bypasses the 30s
 * API Gateway HTTP API timeout — large videos commonly run 1-5 min).
 * Falls back to the HTTP API Gateway URL if AWS creds aren't around.
 *
 * Exported for the MediaConvert webhook so it can reuse the same path.
 */
export async function callPinLambda(
  body: { bucket: string; prefix?: string; keys?: string[] },
  bearerToken: string,
): Promise<{
  cid?: string;
  files?: number;
  totalBytes?: number;
  manifest?: PinManifestEntry[];
}> {
  const fnName = process.env.IPFS_LAMBDA_NAME;
  const url = process.env.IPFS_LAMBDA_URL;
  const canDirect = Boolean(
    fnName && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_REGION,
  );

  if (canDirect) {
    const { invokeApiGatewayLambda } = await import("./aws-lambda.server");
    return invokeApiGatewayLambda(fnName!, {
      routeKey: "POST /pin",
      headers: { authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify(body),
    });
  }

  if (!url) {
    throw new Error(
      "Set IPFS_LAMBDA_NAME (+ AWS creds) for direct invoke, or IPFS_LAMBDA_URL for HTTP fallback.",
    );
  }

  const res = await fetch(`${url.replace(/\/$/, "")}/pin`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `IPFS Lambda /pin failed [${res.status}] (likely API Gateway 30s timeout — set IPFS_LAMBDA_NAME for direct invoke): ${text.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`IPFS Lambda /pin returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Health probe — calls `GET /health` on the Lambda. Useful to surface
 * "node not reachable" in the UI before kicking off a long upload.
 */
export const ipfsLambdaHealth = createServerFn({ method: "GET" }).handler(
  async () => {
    const fnName = process.env.IPFS_LAMBDA_NAME;
    if (fnName && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_REGION) {
      try {
        const { invokeApiGatewayLambda } = await import("./aws-lambda.server");
        const body = await invokeApiGatewayLambda<unknown>(fnName, {
          routeKey: "GET /health",
          headers: {},
        });
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(body).slice(0, 500),
          transport: "direct-invoke",
        };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          body: "",
          transport: "direct-invoke",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const url = process.env.IPFS_LAMBDA_URL;
    if (!url) {
      return {
        ok: false,
        status: 0,
        body: "",
        transport: "none",
        reason: "Neither IPFS_LAMBDA_NAME (+AWS creds) nor IPFS_LAMBDA_URL set",
      };
    }
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`);
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        body: text.slice(0, 500),
        transport: "api-gateway",
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: "",
        transport: "api-gateway",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  },
);