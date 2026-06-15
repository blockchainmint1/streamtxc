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