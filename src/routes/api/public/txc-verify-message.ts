import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { verifyMessage } from "@/lib/txc.server";

const schema = z.object({
  address: z.string().trim().min(20).max(120),
  signature: z.string().trim().min(8).max(500),
  message: z.string().max(5000),
});

function rpcUrl(): string {
  const raw = process.env.TXC_RPC_URL;
  if (!raw) throw new Error("TXC_RPC_URL missing");
  let u = raw.trim();
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  const hostPart = u.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const hasPort = /:\d+$/.test(hostPart);
  const isHttps = /^https:\/\//.test(u);
  if (!hasPort && !isHttps) {
    const port = process.env.TXC_RPC_PORT || "15739";
    u = u.replace(/\/?$/, "") + ":" + port;
  }
  return u;
}

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const user = process.env.TXC_RPC_USER;
  const pass = process.env.TXC_RPC_PASS;
  if (!user || !pass) throw new Error("TXC_RPC credentials missing");
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: "txc-verify", method, params }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`TXC RPC ${method} failed [${res.status}]: ${text}`);
  }
  const json = JSON.parse(text) as { result: T; error: { message: string } | null };
  if (json.error) throw new Error(`TXC RPC ${method} error: ${json.error.message}`);
  return json.result;
}

export const Route = createFileRoute("/api/public/txc-verify-message")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const input = schema.parse(await request.json());
          const trimmedAddress = input.address.trim();
          const trimmedSignature = input.signature.trim();
          const trimmedMessage = input.message;
          const base64Bytes = Buffer.from(trimmedSignature, "base64");
          const verifyResult = await verifyMessage(
            trimmedAddress,
            trimmedSignature,
            trimmedMessage,
          );

          let validateAddress: unknown = null;
          try {
            validateAddress = await rpc<unknown>("validateaddress", [trimmedAddress]);
          } catch (error) {
            validateAddress = {
              error: error instanceof Error ? error.message : String(error),
            };
          }

          return Response.json({
            ok: true,
            verifyResult,
            address: trimmedAddress,
            message: trimmedMessage,
            signature: {
              length: trimmedSignature.length,
              bytes: base64Bytes.length,
              headerByte: base64Bytes[0] ?? null,
            },
            validateAddress,
          });
        } catch (error) {
          return Response.json(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            { status: 400 },
          );
        }
      },
    },
  },
});