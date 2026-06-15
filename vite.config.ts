// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      // ipfs-only-hash → ipfs-unixfs-importer pulls Node's Buffer in the
      // browser. Polyfill Buffer (and process, for transitive deps) so the
      // client bundle ships a real implementation instead of Vite's empty
      // node:* external stub.
      nodePolyfills({
        include: ["buffer", "process"],
        globals: { Buffer: true, process: true, global: true },
        protocolImports: true,
      }),
    ],
  },
});
