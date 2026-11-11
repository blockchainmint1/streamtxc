// Server functions wrapping the self-hosted IPFS pinning Lambda
// (POST /pin, POST /pin-cid). Lambda streams S3 objects into the
// kubo node at IPFS_API and returns the resulting wrap-dir CID plus a
// per-file manifest (inner file CIDs match locally-computed v1 CIDs
// since the Lambda uses cid-version=1 + raw-leaves=true).
//
// Configured by the txc-ipfs-deploy-v3.sh stack. Two env vars:
//   IPFS_LAMBDA_URL    https://<api-id>.execute-api.<region>.amazonaws.com
//   IPFS_LAMBDA_TOKEN  bearer token printed by the deploy script

import { createServerFn } from "@tanstack/react-start";
import { optionalWalletSession } from "./wallet-auth.functions";
import { transcodeAllowed, isValidCid, type TranscodeGuardRow } from "./transcode-guard";

async function assertPinAllowed(cid: string, wallet: string | null) {
  if (!isValidCid(cid)) throw new Error("Invalid cid");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("videos")
    .select("owner_wallet, hls_cid, transcode_status, created_at")
    .eq("cid", cid)
    .maybeSingle();
  // An in-flight conversion is expected here; only block finished/owned-by-others.
  const r = row as TranscodeGuardRow | null;
  const v = transcodeAllowed(r && r.transcode_status === "processing" ? { ...r, transcode_status: null } : r, wallet, Date.now());
  if (!v.ok) throw new Error(v.reason);
}

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
  .middleware([optionalWalletSession])
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
  .handler(async ({ data, context }): Promise<PinFromS3Result> => {
    const token = process.env.IPFS_LAMBDA_TOKEN;
    if (!token) throw new Error("IPFS_LAMBDA_TOKEN missing");
    // Browser callers may only pin their own single upload from our input bucket.
    const bucket = process.env.AWS_S3_INPUT_BUCKET;
    if (!bucket) throw new Error("bucket required (no AWS_S3_INPUT_BUCKET default)");
    if (data.bucket && data.bucket !== bucket) throw new Error("Invalid bucket");
    if (data.prefix || !data.keys || data.keys.length !== 1) throw new Error("Pin exactly one uploaded file");
    const m = /^inputs\/([A-Za-z0-9]+)$/.exec(data.keys[0]);
    if (!m) throw new Error("Invalid key");
    await assertPinAllowed(m[1], context.wallet);

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
/** Public probe: reports only whether the pinning service answered. */
export const ipfsLambdaHealth = createServerFn({ method: "GET" }).handler(async () => {
  const { probeIpfsLambdaHealth } = await import("./ipfs-lambda-health.server");
  const result = await probeIpfsLambdaHealth();
  return { ok: result.ok };
});

/**
 * Kick off an asynchronous HLS-bundle pin on the IPFS Lambda. Returns
 * immediately (well under 1s) — the Lambda runs to completion in the
 * background and POSTs results to /api/public/hooks/ipfs-pin-complete
 * when done. This is the only viable path for large bundles, because
 * synchronous Lambda invokes from the Cloudflare Worker time out at
 * ~100s while a 2 GB HLS pin can take 5-15 minutes.
 *
 * Requires:
 *   IPFS_LAMBDA_NAME              (Lambda function name, for direct AWS invoke)
 *   AWS_ACCESS_KEY_ID / SECRET / REGION
 *   IPFS_LAMBDA_TOKEN             (bearer the lambda checks)
 *   MEDIACONVERT_WEBHOOK_SECRET   (HMAC secret, reused for the callback)
 *   AWS_S3_OUTPUT_BUCKET, AWS_S3_INPUT_BUCKET
 */
export const kickHlsPinAsync = createServerFn({ method: "POST" })
  .middleware([optionalWalletSession])
  .inputValidator((d: { cid: string; jobId: string }) => {
    if (!d.cid || d.cid.length > 200) throw new Error("Invalid cid");
    if (!d.jobId || d.jobId.length > 200) throw new Error("Invalid jobId");
    return d;
  })
  .handler(async ({ data, context }) => {
    await assertPinAllowed(data.cid, context.wallet);
    const { kickHlsPinAsyncForJob } = await import("./hls-pin.server");
    return kickHlsPinAsyncForJob(data);
  });
