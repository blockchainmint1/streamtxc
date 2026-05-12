import { createFileRoute } from "@tanstack/react-router";

// One-shot: mint or fetch a wallet-owned address labeled "platform"
// so we can replace TXC_PLATFORM_ADDRESS with something the hot wallet owns.
// Will be deleted after use.
export const Route = createFileRoute("/api/public/admin/mint-platform-addr")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.TXC_RPC_URL!;
        const user = process.env.TXC_RPC_USER!;
        const pass = process.env.TXC_RPC_PASS!;
        let resolvedUrl = url.trim();
        if (!/^https?:\/\//.test(resolvedUrl)) resolvedUrl = "http://" + resolvedUrl;
        const hostPart = resolvedUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (!/:\d+$/.test(hostPart) && !/^https:/.test(resolvedUrl)) {
          resolvedUrl = resolvedUrl.replace(/\/?$/, "") + ":" + (process.env.TXC_RPC_PORT || "15739");
        }
        const auth = Buffer.from(`${user}:${pass}`).toString("base64");
        const call = async (method: string, params: unknown[] = []) => {
          const r = await fetch(resolvedUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
            body: JSON.stringify({ jsonrpc: "1.0", id: "mint", method, params }),
          });
          return r.json() as Promise<{ result?: unknown; error?: unknown }>;
        };
        const existing = await call("getaddressesbylabel", ["platform"]).catch(() => ({}));
        let addr: string | null = null;
        if (existing && typeof existing === "object" && "result" in existing && existing.result) {
          addr = Object.keys(existing.result as Record<string, unknown>)[0] ?? null;
        }
        let attempts: unknown = null;
        if (!addr) {
          const bech = await call("getnewaddress", ["platform", "bech32"]);
          if (bech.result && typeof bech.result === "string") addr = bech.result;
          else {
            const legacy = await call("getnewaddress", ["platform"]);
            if (legacy.result && typeof legacy.result === "string") addr = legacy.result;
            attempts = { bech, legacy };
          }
        }
        return Response.json({ ok: !!addr, address: addr, attempts });
      },
    },
  },
});
