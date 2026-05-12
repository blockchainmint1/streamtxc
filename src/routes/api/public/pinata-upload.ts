import { createFileRoute } from "@tanstack/react-router";
import { pinFileToIPFS } from "@/lib/pinata.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Server-side proxy for Pinata uploads. Pinata's tus presigned-URL flow
 * omits CORS headers on error responses and is also frequently broken by
 * wallet browser-extensions that intercept fetch (Phantom, MetaMask, etc.).
 * Forwarding through our own origin sidesteps both issues.
 */
export const Route = createFileRoute("/api/public/pinata-upload")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        try {
          const form = await request.formData();
          const file = form.get("file");
          const filename =
            (form.get("filename") as string | null) ||
            (file instanceof File ? file.name : "upload.bin");
          if (!(file instanceof Blob)) {
            return new Response(
              JSON.stringify({ error: "Missing 'file' field" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json", ...corsHeaders },
              },
            );
          }
          const result = await pinFileToIPFS(file, filename);
          return new Response(
            JSON.stringify({
              cid: result.cid,
              size: result.size,
              id: result.pinataId,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "upload failed";
          return new Response(JSON.stringify({ error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      },
    },
  },
});