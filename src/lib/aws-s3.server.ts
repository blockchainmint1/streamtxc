// AWS S3 helpers for the transcode pipeline. Worker-friendly (aws4fetch).

import { AwsClient } from "aws4fetch";

function s3Client() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error("AWS not configured");
  }
  return new AwsClient({ accessKeyId, secretAccessKey, region, service: "s3" });
}

function s3Host(bucket: string) {
  const region = process.env.AWS_REGION!;
  // Path-style is the most reliable across regions and doesn't require DNS
  // for bucket subdomains. Fine for our internal-only buckets.
  return `https://s3.${region}.amazonaws.com/${bucket}`;
}

/** Presigned PUT URL the browser uses to upload directly to S3 (no CORS hop through our Worker). */
export async function createPresignedPutUrl(opts: {
  bucket: string;
  key: string;
  contentType: string;
  expiresSeconds?: number;
}): Promise<string> {
  const client = s3Client();
  const url = new URL(`${s3Host(opts.bucket)}/${encodeURIComponent(opts.key).replace(/%2F/g, "/")}`);
  if (opts.expiresSeconds) {
    url.searchParams.set("X-Amz-Expires", String(opts.expiresSeconds));
  }
  const signed = await client.sign(
    new Request(url.toString(), { method: "PUT", headers: { "content-type": opts.contentType } }),
    {
      aws: { signQuery: true },
      // X-Amz-Expires must be present before signing; mutating it after signing invalidates the signature.
    },
  );
  return signed.url;
}

/** List object keys under a prefix. Returns full keys (not stripped of prefix). */
export async function listObjects(bucket: string, prefix: string): Promise<string[]> {
  const client = s3Client();
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const url = new URL(s3Host(bucket));
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
    const res = await client.fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`S3 list failed [${res.status}]: ${await res.text().catch(() => "")}`);
    }
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    continuationToken = truncated ? tokenMatch?.[1] : undefined;
  } while (continuationToken);
  return keys;
}

/** Fetch an object's bytes. Use for small text files (playlists). */
export async function getObjectBytes(bucket: string, key: string): Promise<Uint8Array> {
  const client = s3Client();
  const url = `${s3Host(bucket)}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  const res = await client.fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`S3 get failed [${res.status}]: ${await res.text().catch(() => "")}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Stream an object as a Blob, preserving content-type. */
export async function getObjectBlob(bucket: string, key: string): Promise<Blob> {
  const client = s3Client();
  const url = `${s3Host(bucket)}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  const res = await client.fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`S3 get failed [${res.status}]: ${await res.text().catch(() => "")}`);
  }
  return await res.blob();
}

/**
 * Server-side S3 copy. Used to land the original input file inside the
 * HLS output prefix so the IPFS Lambda can pin original + ladder under
 * one wrap-directory CID. Single-bucket operation per call; cross-bucket
 * copy is supported by passing `srcBucket`.
 */
export async function copyObject(opts: {
  srcBucket: string;
  srcKey: string;
  dstBucket: string;
  dstKey: string;
}): Promise<void> {
  const client = s3Client();
  const url = `${s3Host(opts.dstBucket)}/${encodeKey(opts.dstKey)}`;
  // x-amz-copy-source must be URL-encoded "/{bucket}/{key}"
  const copySource = `/${opts.srcBucket}/${encodeKey(opts.srcKey)}`;
  const res = await client.fetch(url, {
    method: "PUT",
    headers: { "x-amz-copy-source": copySource },
  });
  if (!res.ok) {
    throw new Error(`S3 copy failed [${res.status}]: ${await res.text().catch(() => "")}`);
  }
}

// ---- Multipart upload helpers ---------------------------------------------
// Browser flow:
//   1. createMultipart → uploadId
//   2. for each part: signMultipartPartUrl → PUT directly to S3 → collect ETag
//   3. completeMultipart with [{PartNumber, ETag}, …]
// On any failure the client should call abortMultipart to free storage.

function encodeKey(key: string) {
  return encodeURIComponent(key).replace(/%2F/g, "/");
}

export async function createMultipartUpload(opts: {
  bucket: string;
  key: string;
  contentType: string;
}): Promise<{ uploadId: string }> {
  const client = s3Client();
  const url = `${s3Host(opts.bucket)}/${encodeKey(opts.key)}?uploads=`;
  const res = await client.fetch(url, {
    method: "POST",
    headers: { "content-type": opts.contentType },
  });
  if (!res.ok) {
    throw new Error(`S3 createMultipart failed [${res.status}]: ${await res.text().catch(() => "")}`);
  }
  const xml = await res.text();
  const m = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!m) throw new Error("S3 createMultipart: no UploadId in response");
  return { uploadId: m[1] };
}

export async function signMultipartPartUrl(opts: {
  bucket: string;
  key: string;
  uploadId: string;
  partNumber: number;
  expiresSeconds?: number;
}): Promise<string> {
  const client = s3Client();
  const url = new URL(`${s3Host(opts.bucket)}/${encodeKey(opts.key)}`);
  url.searchParams.set("partNumber", String(opts.partNumber));
  url.searchParams.set("uploadId", opts.uploadId);
  if (opts.expiresSeconds) url.searchParams.set("X-Amz-Expires", String(opts.expiresSeconds));
  const signed = await client.sign(
    new Request(url.toString(), { method: "PUT" }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

export async function completeMultipartUpload(opts: {
  bucket: string;
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
}): Promise<void> {
  const client = s3Client();
  const url = `${s3Host(opts.bucket)}/${encodeKey(opts.key)}?uploadId=${encodeURIComponent(opts.uploadId)}`;
  const sorted = [...opts.parts].sort((a, b) => a.partNumber - b.partNumber);
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CompleteMultipartUpload>` +
    sorted
      .map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag.replace(/"/g, "&quot;")}</ETag></Part>`,
      )
      .join("") +
    `</CompleteMultipartUpload>`;
  const res = await client.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body,
  });
  if (!res.ok) {
    throw new Error(`S3 completeMultipart failed [${res.status}]: ${await res.text().catch(() => "")}`);
  }
  // S3 may return 200 with an error embedded in the body.
  const xml = await res.text();
  if (/<Error>/.test(xml)) {
    throw new Error(`S3 completeMultipart returned error: ${xml.slice(0, 500)}`);
  }
}

export async function abortMultipartUpload(opts: {
  bucket: string;
  key: string;
  uploadId: string;
}): Promise<void> {
  const client = s3Client();
  const url = `${s3Host(opts.bucket)}/${encodeKey(opts.key)}?uploadId=${encodeURIComponent(opts.uploadId)}`;
  await client.fetch(url, { method: "DELETE" }).catch(() => {});
}