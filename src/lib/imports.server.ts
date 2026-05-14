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
// Pinata's v3 /files endpoint takes multipart/form-data. Building FormData
// with a Blob would buffer the whole file in memory. Instead we hand-build
// the multipart body as a ReadableStream so the bytes flow through without
// being held.

const PINATA_UPLOADS = "https://uploads.pinata.cloud/v3";

export interface StreamPinResult {
  cid: string;
  size: number;
}

export async function pinStreamToIPFS(args: {
  body: ReadableStream<Uint8Array>;
  filename: string;
  /** Pre-known content length of the file. Required for multipart Content-Length. */
  sizeBytes: number;
  mime?: string;
}): Promise<StreamPinResult> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not configured");

  const boundary = `----lovable-${randomUUID().replace(/-/g, "")}`;
  const enc = new TextEncoder();

  // Multipart parts (in order):
  //   1. network = "public"
  //   2. pinataOptions = '{"cidVersion":1}'
  //   3. file = <stream>
  const safeName = args.filename.replace(/"/g, "");
  const filePartHeader =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
    `Content-Type: ${args.mime || "application/octet-stream"}\r\n\r\n`;

  const networkPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="network"\r\n\r\npublic\r\n`;

  const optsPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="pinataOptions"\r\n\r\n` +
    JSON.stringify({ cidVersion: 1 }) +
    `\r\n`;

  const trailer = `\r\n--${boundary}--\r\n`;

  const headerBytes = enc.encode(networkPart + optsPart + filePartHeader);
  const trailerBytes = enc.encode(trailer);
  const totalLength = headerBytes.byteLength + args.sizeBytes + trailerBytes.byteLength;

  // Stitch [header, body-stream, trailer] into a single ReadableStream.
  const reader = args.body.getReader();
  const stitched = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(headerBytes);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(trailerBytes);
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* noop */
      }
    },
  });

  // Cloudflare Workers / undici require `duplex: "half"` for streamed
  // request bodies; lib.dom's RequestInit doesn't type it yet.
  const init = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(totalLength),
    },
    body: stitched,
    duplex: "half",
  } as RequestInit;
  const res = await fetch(`${PINATA_UPLOADS}/files`, init);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata stream upload failed [${res.status}]: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data: { cid: string; size: number } };
  return { cid: json.data.cid, size: json.data.size };
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