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

// --- Streaming pin to Pinata --------------------------------------------
//
// Pinata officially recommends the TUS resumable protocol for files >100MB.
// Single-shot multipart was hitting their edge with 503s on multi-GB uploads
// (the worker would push for many minutes and Pinata's frontend would 503
// the whole request). TUS chunks the upload into ~50MB PATCHes — each small
// enough to be retried individually on 5xx — while still streaming bytes
// straight from the source URL through the worker, never buffering the
// full file.

const PINATA_UPLOADS = "https://uploads.pinata.cloud/v3";
const PINATA_API = "https://api.pinata.cloud/v3";
const TUS_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MB per Pinata's recommendation
const TUS_MAX_RETRIES = 6;
const TUS_RETRY_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 20_000, 30_000];

export interface StreamPinResult {
  cid: string;
  size: number;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
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
 * Resolve the freshly-uploaded file's CID by querying Pinata's files API
 * for the unique keyvalue we tagged it with.
 */
async function lookupFileByKeyvalue(
  jwt: string,
  uploadKey: string,
): Promise<{ cid: string; size: number } | null> {
  // Pinata indexes new files within a few seconds of TUS completion.
  // Poll briefly.
  const url = `${PINATA_API}/files/public?metadata[upload_key]=${encodeURIComponent(uploadKey)}&limit=1`;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { files?: { cid: string; size: number }[] };
        };
        const f = json.data?.files?.[0];
        if (f?.cid) return { cid: f.cid, size: f.size };
      }
    } catch {
      /* keep polling */
    }
    await sleep(2_000);
  }
  return null;
}

/**
 * Upload via TUS (resumable). Streams from `body`, buffers up to
 * TUS_CHUNK_SIZE in memory at a time, PATCHes each chunk with retry,
 * then resolves the resulting CID via the files API.
 */
export async function pinStreamToIPFS(args: {
  body: ReadableStream<Uint8Array>;
  filename: string;
  /** Pre-known content length of the file. Required by TUS Upload-Length. */
  sizeBytes: number;
  mime?: string;
  /** Called as bytes are flushed to Pinata, for the progress bar. */
  onProgress?: (bytes: number) => void;
}): Promise<StreamPinResult> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not configured");

  const filetype = args.mime || "application/octet-stream";
  const uploadKey = randomUUID();

  // 1) Create the upload.
  const createMetadata = [
    `filename ${b64(args.filename)}`,
    `filetype ${b64(filetype)}`,
    `network ${b64("public")}`,
    // Tag with a unique key so we can find the resulting file's CID afterwards.
    `keyvalues ${b64(JSON.stringify({ upload_key: uploadKey }))}`,
  ].join(",");

  const createRes = await fetch(`${PINATA_UPLOADS}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(args.sizeBytes),
      "Upload-Metadata": createMetadata,
    },
  });
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => "");
    throw new Error(
      `Pinata TUS create failed [${createRes.status}]: ${text.slice(0, 300)}`,
    );
  }
  const location = createRes.headers.get("location");
  if (!location) {
    throw new Error("Pinata TUS create returned no Location header");
  }
  const uploadUrl = location.startsWith("http")
    ? location
    : new URL(location, PINATA_UPLOADS).toString();

  // 2) PATCH chunks.
  const reader = args.body.getReader();
  const leftover = { buf: null as Uint8Array | null };
  let offset = 0;

  while (offset < args.sizeBytes) {
    const want = Math.min(TUS_CHUNK_SIZE, args.sizeBytes - offset);
    const { chunk } = await readChunk(reader, want, leftover);
    if (chunk.byteLength === 0) {
      throw new Error(
        `Upstream ended early at byte ${offset}/${args.sizeBytes}`,
      );
    }

    let success = false;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < TUS_MAX_RETRIES; attempt++) {
      try {
        const patchRes = await fetch(uploadUrl, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
            "Content-Length": String(chunk.byteLength),
          },
          body: chunk,
        });
        if (patchRes.status === 204 || patchRes.status === 200) {
          const newOffset = Number(
            patchRes.headers.get("upload-offset") ?? offset + chunk.byteLength,
          );
          offset = newOffset;
          args.onProgress?.(offset);
          success = true;
          break;
        }
        // Retry on 5xx and 409 (offset mismatch — re-sync via HEAD).
        if (patchRes.status >= 500 || patchRes.status === 409) {
          const text = await patchRes.text().catch(() => "");
          lastErr = new Error(
            `PATCH ${patchRes.status} at offset ${offset}: ${text.slice(0, 200)}`,
          );
          // Re-sync offset from the server before retrying.
          try {
            const head = await fetch(uploadUrl, {
              method: "HEAD",
              headers: {
                Authorization: `Bearer ${jwt}`,
                "Tus-Resumable": "1.0.0",
              },
            });
            const serverOffset = Number(head.headers.get("upload-offset") ?? offset);
            if (Number.isFinite(serverOffset) && serverOffset > offset) {
              // Server somehow advanced — accept and skip ahead.
              offset = serverOffset;
              args.onProgress?.(offset);
              success = true;
              break;
            }
          } catch {
            /* ignore HEAD failure, just back off */
          }
          await sleep(TUS_RETRY_DELAYS_MS[attempt] ?? 30_000);
          continue;
        }
        // Permanent error.
        const text = await patchRes.text().catch(() => "");
        throw new Error(
          `Pinata TUS PATCH failed [${patchRes.status}] at offset ${offset}: ${text.slice(0, 300)}`,
        );
      } catch (err) {
        lastErr = err;
        // Network error — retry with backoff.
        if (attempt < TUS_MAX_RETRIES - 1) {
          await sleep(TUS_RETRY_DELAYS_MS[attempt] ?? 30_000);
          continue;
        }
      }
    }
    if (!success) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error("Pinata TUS PATCH failed after retries");
    }
  }

  // 3) Resolve the CID.
  const found = await lookupFileByKeyvalue(jwt, uploadKey);
  if (!found) {
    throw new Error(
      "Upload completed but Pinata didn't surface a CID — check the Files dashboard.",
    );
  }
  return { cid: found.cid, size: found.size };
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