// Browser-side CID computation. Mirrors our kubo import settings:
//   cidVersion: 1, rawLeaves: true, chunker: 256 KiB.
// Lets us check "is this file already on IPFS?" before uploading the bytes.
//
// We compute BOTH CIDv1 (rawLeaves:true) AND CIDv0
// (legacy default — rawLeaves:false, dag-pb leaves) because the same bytes
// produce different CIDs under each scheme, and a file pinned by an older
// client (or by `ipfs add` with default flags) will only resolve under v0.
// Buffer is provided globally by vite-plugin-node-polyfills (see
// vite.config.ts). ipfs-only-hash → ipfs-unixfs-importer needs it in the
// browser; nothing to do here at import time.
import Hash from "ipfs-only-hash";

export async function computeCidV1(file: File | Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return Hash.of(buf, { cidVersion: 1, rawLeaves: true });
}

export async function computeCidV0(file: File | Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return Hash.of(buf, { cidVersion: 0, rawLeaves: false });
}

/**
 * Compute both CIDv1 and CIDv0 (legacy `ipfs add` default).
 *
 * Uses a Web Worker that streams the file so multi-GB uploads don't freeze
 * the tab or balloon memory. Falls back to the buffered path if Workers
 * aren't available (e.g. during SSR or in tests). `onProgress` (0-100) fires
 * during the worker path only.
 */
export async function computeCids(
  file: File | Blob,
  onProgress?: (pct: number) => void,
): Promise<{ v1: string; v0: string }> {
  const isFile = typeof File !== "undefined" && file instanceof File;
  if (
    isFile &&
    typeof window !== "undefined" &&
    typeof Worker !== "undefined"
  ) {
    return await hashInWorker(file as File, onProgress);
  }
  // Fallback: buffered (legacy path).
  const buf = new Uint8Array(await file.arrayBuffer());
  const [v1, v0] = await Promise.all([
    Hash.of(buf, { cidVersion: 1, rawLeaves: true }),
    Hash.of(buf, { cidVersion: 0, rawLeaves: false }),
  ]);
  return { v1, v0 };
}

function hashInWorker(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ v1: string; v0: string }> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./cid-hash.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: "progress"; loaded: number; total: number }
        | { type: "done"; v1: string; v0: string }
        | { type: "error"; message: string };
      if (msg.type === "progress") {
        if (onProgress && msg.total > 0) {
          onProgress(Math.min(100, (msg.loaded / msg.total) * 100));
        }
      } else if (msg.type === "done") {
        worker.terminate();
        resolve({ v1: msg.v1, v0: msg.v0 });
      } else if (msg.type === "error") {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "CID worker crashed"));
    };
    worker.postMessage({ file });
  });
}

// Note: a previous helper here HEAD-probed /api/stream/:cid to check if a CID
// was "on IPFS". That was unreliable — the stream endpoint 302s to a host
// that returns the SPA shell as 200 for unknown CIDs, producing false hits.
// Use the `lookupPinnedCid` server fn in videos.functions.ts instead, which
// queries our self-hosted node directly.