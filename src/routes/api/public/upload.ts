import { createFileRoute } from "@tanstack/react-router";
import { pinFileToIPFS } from "@/lib/pinata.server";
import { MAX_UPLOAD_BYTES } from "@/lib/fees";

/**
 * Browser → Worker → Pinata upload proxy. Same-origin (no CORS),
 * capped at MAX_UPLOAD_BYTES (≈ Cloudflare Worker request-body cap).
 *
 * Why not direct browser → Pinata? Pinata's TUS endpoint enforces a
 * per-API-key CORS allowlist, which has to be updated for every custom
 * domain we serve from. Routing through our own origin sidesteps that.
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
          const pinned = await pinFileToIPFS(file, filename);
          return Response.json({
            cid: pinned.cid,
            size: pinned.size,
          });
        } catch (err) {
          console.error("upload proxy: Pinata pin failed", err);
          return Response.json(
            {
              error:
                err instanceof Error ? err.message : "Pinata upload failed",
            },
            { status: 502 },
          );
        }
      },
    },
  },
});
