// Server-only helpers for the URL importer:
//   - HMAC-signed import tokens so the streaming endpoint won't accept
//     arbitrary URLs (only ones our resolver just blessed).
//   - Multipart streaming upload to Pinata that wraps the source body in
//     a TransformStream counting bytes so we can keep an `imports` row in
//     sync for the polling progress bar.

import { createHmac, randomUUID } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ImportSource } from "./import-sources.server";

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB hard cap
const TOKEN_TTL_MS = 15 * 60_000;

function signingKey(): string {
  // Re-use an existing server secret instead of asking the user for a new one.
  // The token is server-issued and server-verified — it never crosses a
  // trust boundary outside our Worker.
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing — required to sign import tokens");
  return k;
}

export interface ImportTokenPayload {
  source: ImportSource;
  directUrl: string;
  filename: string;
  sizeBytes: number | null;
  sourceUrl: string;
  fetchHeaders?: Record<string, string>;
  exp: number;
}

export function signImportToken(p: ImportTokenPayload): string {
  const body = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  const sig = createHmac("sha256", signingKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyImportToken(token: string): ImportTokenPayload {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("Malformed import token");
  const expected = createHmac("sha256", signingKey()).update(body).digest("base64url");
  if (expected !== sig) throw new Error("Invalid import token signature");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ImportTokenPayload;
  if (payload.exp < Date.now()) {
    throw new Error("Import token expired — resolve the link again.");
  }
  return payload;
}

// --- DB row lifecycle ----------------------------------------------------

export async function createImportRow(args: {
  source: ImportSource;
  sourceUrl: string;
  filename: string;
  bytesTotal: number | null;
}) {
  const { data, error } = await supabaseAdmin
    .from("imports")
    .insert({
      source: args.source,
      source_url: args.sourceUrl,
      filename: args.filename,
      bytes_total: args.bytesTotal,
      status: "streaming",
    })
    .select("id")
    .single();
  if (error) throw new Error(`Failed to create import row: ${error.message}`);
  return data.id as string;
}

async function updateImportRow(id: string, patch: Record<string, unknown>) {
  await supabaseAdmin
    .from("imports")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

export async function markImportProgress(id: string, bytes: number) {
  await updateImportRow(id, { bytes_uploaded: bytes });
}

export async function markImportDone(id: string, cid: string, bytes: number) {
  await updateImportRow(id, {
    status: "done",
    cid,
    bytes_uploaded: bytes,
  });
}

export async function markImportFailed(id: string, msg: string) {
  await updateImportRow(id, { status: "failed", error_message: msg.slice(0, 500) });
}

// --- Streaming pin via S3 → self-hosted IPFS Lambda ---------------------
//
// Strategy (matches the rest of the app: self-node primary, Pinata backup):
//   1. Open an S3 multipart upload into AWS_S3_INPUT_BUCKET/imports/{uuid}.
//   2. Stream the source body through the Worker, PUT-ing one part at a
//      time. Each part is ~50 MB so memory stays bounded and retries are
//      cheap. Workers handle the part-by-part HTTP nicely (subrequest budget
//      is per-request, not per-byte).
//   3. Complete the multipart upload.
//   4. Call the IPFS Lambda's POST /pin with that S3 key. Lambda streams
//      the object into kubo and returns the CID.
//   5. Fire-and-forget Pinata backup pin (pinByHash on the same CID).
//   6. Delete the temp S3 object — the bytes now live in kubo, S3 was just
//      the conduit.
//
// Part size + retry tuned to S3, not Pinata. Same chunked-reader contract
// as the previous TUS implementation, so the import-stream route is a
// drop-in caller.

const PART_SIZE = 50 * 1024 * 1024; // 50 MB — well above S3's 5 MB minimum
const PART_MAX_RETRIES = 6;
const PART_RETRY_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 20_000, 30_000];

export interface StreamPinResult {
  cid: string;
  size: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read exactly `want` bytes from `reader` into a single Uint8Array, OR
 * less if the stream ends. Returns `{ chunk, done }` where `done=true`
 * means the upstream is exhausted (the chunk may still contain trailing
 * bytes shorter than `want`).
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  want: number,
  leftover: { buf: Uint8Array | null },
): Promise<{ chunk: Uint8Array; done: boolean }> {
  const parts: Uint8Array[] = [];
  let have = 0;

  if (leftover.buf && leftover.buf.byteLength > 0) {
    if (leftover.buf.byteLength >= want) {
      const out = leftover.buf.subarray(0, want);
      leftover.buf = leftover.buf.subarray(want);
      return { chunk: out, done: false };
    }
    parts.push(leftover.buf);
    have += leftover.buf.byteLength;
    leftover.buf = null;
  }

  while (have < want) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.byteLength === 0) continue;
    if (have + value.byteLength <= want) {
      parts.push(value);
      have += value.byteLength;
    } else {
      const need = want - have;
      parts.push(value.subarray(0, need));
      leftover.buf = value.subarray(need);
      have = want;
      break;
    }
  }

  // Concatenate
  const out = new Uint8Array(have);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  // We're "done" if we couldn't fill the requested size AND the stream
  // returned done. The caller decides what to do with a short final chunk.
  const done = have < want;
  return { chunk: out, done };
}

/**
 * Stream a remote file body into our self-hosted IPFS node, with Pinata
 * as a backup. Pipeline: source → Worker → S3 (multipart) → Lambda /pin →
 * kubo. Returns the file CID. Used by the URL and Zoom importers.
 */
export async function pinStreamToIPFS(args: {
  body: ReadableStream<Uint8Array>;
  filename: string;
  /** Pre-known content length of the file. Required to drive multipart sizing. */
  sizeBytes: number;
  mime?: string;
  /** Called as bytes are PUT to S3, for the progress bar. */
  onProgress?: (bytes: number) => void;
}): Promise<StreamPinResult> {
  const bucket = process.env.AWS_S3_INPUT_BUCKET;
  if (!bucket) throw new Error("AWS_S3_INPUT_BUCKET missing");
  const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
  if (!lambdaToken) throw new Error("IPFS_LAMBDA_TOKEN missing");

  const {
    createMultipartUpload,
    completeMultipartUpload,
    abortMultipartUpload,
    s3UploadPart,
    deleteObject,
  } = await import("./aws-s3.server");

  const key = `imports/${randomUUID()}`;
  const ct = args.mime || "application/octet-stream";

  const { uploadId } = await createMultipartUpload({
    bucket,
    key,
    contentType: ct,
  });

  const reader = args.body.getReader();
  const leftover = { buf: null as Uint8Array | null };
  const parts: { partNumber: number; etag: string }[] = [];
  let offset = 0;
  let partNumber = 1;

  try {
    while (offset < args.sizeBytes) {
      const want = Math.min(PART_SIZE, args.sizeBytes - offset);
      const { chunk } = await readChunk(reader, want, leftover);
      if (chunk.byteLength === 0) {
        throw new Error(
          `Upstream ended early at byte ${offset}/${args.sizeBytes}`,
        );
      }

      let etag: string | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < PART_MAX_RETRIES; attempt++) {
        try {
          etag = await s3UploadPart({
            bucket,
            key,
            uploadId,
            partNumber,
            body: chunk,
          });
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < PART_MAX_RETRIES - 1) {
            await sleep(PART_RETRY_DELAYS_MS[attempt] ?? 30_000);
            continue;
          }
        }
      }
      if (!etag) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error(`S3 part ${partNumber} failed after retries`);
      }

      parts.push({ partNumber, etag });
      offset += chunk.byteLength;
      partNumber++;
      args.onProgress?.(offset);
    }

    await completeMultipartUpload({ bucket, key, uploadId, parts });
  } catch (err) {
    await abortMultipartUpload({ bucket, key, uploadId });
    throw err;
  }

  // S3 object is now sitting at s3://bucket/key. Push it into kubo via
  // the IPFS Lambda. /pin always wraps the upload in a directory, so the
  // raw file CID is the first manifest entry, not the wrap CID.
  const { callPinLambda } = await import("./ipfs-lambda.functions");
  const pinned = await callPinLambda(
    { bucket, keys: [key] },
    lambdaToken,
  );
  const fileCid = pinned.manifest?.[0]?.cid ?? pinned.cid ?? "";
  if (!fileCid) {
    throw new Error("IPFS Lambda /pin returned no CID");
  }

  // Backup: fire-and-forget Pinata pin. Never throws.
  const { pinByCid } = await import("./pinata.server");
  pinByCid(fileCid, args.filename).catch((e) =>
    console.warn(`import backup pin failed for ${fileCid}:`, e),
  );

  // Best-effort delete the temp S3 object. The bytes now live in kubo;
  // S3 was a conduit.
  deleteObject(bucket, key).catch((e) =>
    console.warn(`import temp delete failed for ${key}:`, e),
  );

  return { cid: fileCid, size: pinned.totalBytes ?? args.sizeBytes };
}

/**
 * Wrap a ReadableStream so it calls `onBytes(totalSoFar)` periodically as
 * data flows through. Used by the import streamer to update the `imports`
 * row for the UI's progress bar.
 */
export function wrapWithProgress(
  body: ReadableStream<Uint8Array>,
  onBytes: (total: number) => void,
  intervalBytes = 1024 * 256,
): ReadableStream<Uint8Array> {
  let total = 0;
  let lastReported = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total - lastReported >= intervalBytes) {
          lastReported = total;
          // fire-and-forget; never block the stream on a DB write
          try {
            onBytes(total);
          } catch {
            /* noop */
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        try {
          onBytes(total);
        } catch {
          /* noop */
        }
      },
    }),
  );
}