// POST /api/public/import-stream
//
// Body: { token: string }   (signed by resolveImportUrl)
// Returns: { id, cid, size }
//
// The Worker fetches the resolved direct URL (WeTransfer / Dropbox) and
// pipes the body through a byte-counting TransformStream into a streamed
// multipart upload to Pinata. Memory stays bounded; only one in-flight
// chunk at a time. An `imports` row tracks progress for the UI's
// polling progress bar.
//
// Token requirement: the streaming endpoint refuses to fetch arbitrary
// URLs — only ones our resolver just blessed — to keep this from being
// a generic "send any URL into our Pinata account" amplifier.

import { createFileRoute } from "@tanstack/react-router";
import {
  verifyImportToken,
  createImportRow,
  markImportProgress,
  markImportDone,
  markImportFailed,
  pinStreamToIPFS,
  wrapWithProgress,
  IMPORT_MAX_BYTES,
} from "@/lib/imports.server";

export const Route = createFileRoute("/api/public/import-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { token?: string };
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Bad JSON" }, { status: 400 });
        }
        const token = body.token;
        if (!token || typeof token !== "string") {
          return Response.json({ error: "Missing token" }, { status: 400 });
        }

        let payload;
        try {
          payload = verifyImportToken(token);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Bad token" },
            { status: 401 },
          );
        }

        const importId = await createImportRow({
          source: payload.source,
          sourceUrl: payload.sourceUrl,
          filename: payload.filename,
          bytesTotal: payload.sizeBytes,
        });

        try {
          // Open the upstream stream.
          const upstream = await fetch(payload.directUrl);
          if (!upstream.ok || !upstream.body) {
            throw new Error(
              `Upstream returned ${upstream.status} when fetching the file.`,
            );
          }

          // Trust upstream Content-Length when available; fall back to the
          // size from the resolver. We need a known length to set the
          // multipart Content-Length header.
          const upstreamLen = Number(
            upstream.headers.get("content-length") ?? "",
          );
          const sizeBytes =
            Number.isFinite(upstreamLen) && upstreamLen > 0
              ? upstreamLen
              : payload.sizeBytes;
          if (!sizeBytes) {
            throw new Error(
              "Couldn't determine file size from upstream — refusing to stream without a known length.",
            );
          }
          if (sizeBytes > IMPORT_MAX_BYTES) {
            throw new Error(
              `File too large (${(sizeBytes / 1024 ** 3).toFixed(2)} GB) — cap is ${(IMPORT_MAX_BYTES / 1024 ** 3).toFixed(0)} GB.`,
            );
          }

          const tracked = wrapWithProgress(upstream.body, (n) => {
            // Fire-and-forget; never await inside the stream.
            void markImportProgress(importId, n);
          });

          const pinned = await pinStreamToIPFS({
            body: tracked,
            filename: payload.filename,
            sizeBytes,
            mime: upstream.headers.get("content-type") ?? undefined,
          });

          await markImportDone(importId, pinned.cid, pinned.size);

          return Response.json({
            id: importId,
            cid: pinned.cid,
            size: pinned.size,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Import failed";
          console.error("import-stream failed", err);
          await markImportFailed(importId, msg);
          return Response.json(
            { id: importId, error: msg },
            { status: 502 },
          );
        }
      },
    },
  },
});