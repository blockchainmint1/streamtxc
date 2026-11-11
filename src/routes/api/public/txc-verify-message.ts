import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { verifyMessage } from "@/lib/txc.server";

const schema = z.object({
  address: z.string().trim().min(20).max(120),
  signature: z.string().trim().min(8).max(500),
  message: z.string().max(5000),
});

export const Route = createFileRoute("/api/public/txc-verify-message")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const input = schema.parse(await request.json());
          const valid = await verifyMessage(input.address, input.signature, input.message);
          return Response.json({ valid: valid === true });
        } catch {
          // No node or validation details leave the server.
          return Response.json({ valid: false, error: "Invalid request" }, { status: 400 });
        }
      },
    },
  },
});
