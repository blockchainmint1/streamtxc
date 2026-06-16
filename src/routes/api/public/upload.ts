import { createFileRoute } from "@tanstack/react-router";
import { MAX_UPLOAD_BYTES } from "@/lib/fees";

// Allow common browser video formats only. Blocks abuse of the platform's
// Pinata account for arbitrary content pinning.
const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
  "video/ogg",
]);

/**
 * Browser → Worker → S3 → self-hosted IPFS node (ipfs.honest.money).
 * Same-origin (no CORS), capped at MAX_UPLOAD_BYTES.
 *
 * Pipeline:
 *   1. Stream the file into S3 under `uploads/<uuid>/<filename>`.
 *   2. Ask the IPFS pinning Lambda to stream that S3 key into our kubo
 *      node and return the CID.
 *
 * Pinata is no longer touched on the hot upload path — every new video
 * lands on our own IPFS infra.
 */
export const Route = createFileRoute("/api/public/upload")({
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

        const fnameField = form.get("filename");
        const filename = (
          (typeof fnameField === "string" && fnameField) ||
          ("name" in file && typeof file.name === "string" ? file.name : "video")
        ).slice(0, 200);

        if (file.size <= 0) {
          return Response.json({ error: "Empty file" }, { status: 400 });
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          return Response.json(
            {
              error: `File exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB cap. Pin to IPFS first and use Add by CID.`,
            },
            { status: 413 },
          );
        }

        try {
          const [{ s3PutObject }, { callPinLambda }] = await Promise.all([
            import("@/lib/aws-s3.server"),
            import("@/lib/ipfs-lambda.functions"),
          ]);

          const token = process.env.IPFS_LAMBDA_TOKEN;
          if (!token) throw new Error("IPFS_LAMBDA_TOKEN is not configured");
          const bucket = process.env.AWS_S3_INPUT_BUCKET;
          if (!bucket) throw new Error("AWS_S3_INPUT_BUCKET is not configured");

          // Sanitise the filename to a safe S3 key fragment.
          const safeName = filename.replace(/[^\w.\-]+/g, "_");
          const key = `uploads/${crypto.randomUUID()}/${safeName}`;

          await s3PutObject({
            bucket,
            key,
            body: file,
            contentType: mime || "application/octet-stream",
          });

          const pinned = await callPinLambda(
            { bucket, keys: [key] },
            token,
          );
          const manifest = Array.isArray(pinned.manifest) ? pinned.manifest : [];
          const fileCid = manifest[0]?.cid;
          const cid = fileCid || pinned.cid;
          if (!cid) {
            throw new Error("IPFS pinning returned no CID");
          }
          return Response.json({
            cid,
            size: pinned.totalBytes ?? file.size,
            wrapCid: pinned.cid ?? null,
          });
        } catch (err) {
          console.error("upload proxy: self-hosted IPFS pin failed", err);
          return Response.json(
            {
              error:
                err instanceof Error ? err.message : "IPFS upload failed",
            },
            { status: 502 },
          );
        }
      },
    },
  },
});
