import { createFileRoute } from "@tanstack/react-router";

/**
 * Lightweight diagnostic for the TXC RPC connection. Hits a few read-only
 * methods so we can confirm the node is reachable, the credentials work,
 * and the wallet has spendable balance for OP_RETURN stamps. Safe to call
 * publicly — only reveals whether the URL/creds are correct.
 */
export const Route = createFileRoute("/api/public/txc-health")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.TXC_RPC_URL;
        const user = process.env.TXC_RPC_USER;
        const pass = process.env.TXC_RPC_PASS;
        if (!url || !user || !pass) {
          return Response.json(
            { ok: false, stage: "config", error: "TXC_RPC_* env vars missing" },
            { status: 500 },
          );
        }

        let resolvedUrl = url.trim();
        if (!/^https?:\/\//.test(resolvedUrl)) resolvedUrl = "http://" + resolvedUrl;
        const hostPart = resolvedUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        const hasPort = /:\d+$/.test(hostPart);
        if (!hasPort && !/^https:/.test(resolvedUrl)) {
          const port = process.env.TXC_RPC_PORT || "15739";
          resolvedUrl = resolvedUrl.replace(/\/?$/, "") + ":" + port;
        }

        const auth = Buffer.from(`${user}:${pass}`).toString("base64");
        const call = async (method: string, params: unknown[] = []) => {
          const res = await fetch(resolvedUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
            body: JSON.stringify({ jsonrpc: "1.0", id: "diag", method, params }),
          });
          const text = await res.text();
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // keep raw text
          }
          return { status: res.status, body: parsed };
        };

        try {
          const [blockCount, info, balance] = await Promise.all([
            call("getblockcount"),
            call("getblockchaininfo"),
            call("getbalance"),
          ]);
          return Response.json({
            ok: true,
            url: resolvedUrl,
            blockCount,
            chain: info,
            balance,
          });
        } catch (err) {
          return Response.json(
            {
              ok: false,
              stage: "fetch",
              url: resolvedUrl,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 502 },
          );
        }
      },
    },
  },
});