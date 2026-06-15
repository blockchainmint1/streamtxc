import { createFileRoute } from "@tanstack/react-router";
import { MAX_UPLOAD_BYTES } from "@/lib/fees";

const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
  "video/ogg",
]);

export const Route = createFileRoute("/api/public/cid")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ct = request.headers.get("content-type") ?? "";
        if (!ct.includes("multipart/form-data")) {
          return Response.json(
            { error: "Expected multipart/form-data" },
            { status: 400 },
          );
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Bad form data" },
            { status: 400 },
          );
        }

        const file = form.get("file");
        if (file === null || typeof file === "string") {
          return Response.json(
            { error: "Missing 'file' field" },
            { status: 400 },
          );
        }

        const mime = ("type" in file && typeof file.type === "string" ? file.type : "").toLowerCase();
        if (!ALLOWED_MIME_TYPES.has(mime)) {
          return Response.json(
            {
              error: `Unsupported file type: ${mime || "unknown"}. Allowed: MP4, WebM, MOV, MKV, AVI, OGG.`,
            },
            { status: 415 },
          );
        }

        if (file.size <= 0) {
          return Response.json({ error: "Empty file" }, { status: 400 });
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return Response.json(
            { error: `File exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB cap.` },
            { status: 413 },
          );
        }

        try {
          const { computeIpfsCids } = await import("@/lib/ipfs-cid.server");
          return Response.json(await computeIpfsCids(file));
        } catch (err) {
          console.error("cid hash failed", err);
          return Response.json(
            { error: err instanceof Error ? err.message : "CID hashing failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});