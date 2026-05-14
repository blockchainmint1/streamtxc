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
  IMPORT_MAX_BYTES,
} from "@/lib/imports.server";
import { waitUntil } from "@/lib/cf-context.server";

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

        // Run the (potentially many-minute) upload in the background via
        // Cloudflare's waitUntil — the HTTP response returns immediately so
        // we don't depend on the response stream surviving for the whole
        // upload (that's what the previous "Network connection lost" error
        // was). The client polls getImportStatus(id) until status='done' or
        // status='failed'.
        const work = (async () => {
          try {
            const upstream = await fetch(payload.directUrl, {
              headers: payload.fetchHeaders,
              redirect: "follow",
            });
            if (!upstream.ok || !upstream.body) {
              throw new Error(
                `Upstream returned ${upstream.status} when fetching the file.`,
              );
            }

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

            const pinned = await pinStreamToIPFS({
              body: upstream.body,
              filename: payload.filename,
              sizeBytes,
              mime: upstream.headers.get("content-type") ?? undefined,
              onProgress: (n) => {
                void markImportProgress(importId, n);
              },
            });

            await markImportDone(importId, pinned.cid, pinned.size);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Import failed";
            console.error("import-stream failed", err);
            await markImportFailed(importId, msg);
          }
        })();

        const scheduled = waitUntil(work);

        // Preview/dev can lack a working waitUntil context. In that case,
        // detached background work gets dropped as soon as we return the
        // response, leaving the row stuck at `streaming` with 0 bytes.
        // Keep the request open and finish the import inline instead.
        if (!scheduled) {
          await work;
        }

        return Response.json(
          { id: importId, status: scheduled ? "queued" : "processing" },
          {
            status: 202,
            headers: { "Cache-Control": "no-store", "X-Import-Id": importId },
          },
        );
      },
    },
  },
});