// Streaming CID hasher running in a Web Worker so multi-GB files don't
// freeze the upload UI. Runs v1 + v0 sequentially (two reads of the
// file stream) to keep peak memory bounded.
//
// Buffer is polyfilled by vite-plugin-node-polyfills (applies to workers too).
import Hash from "ipfs-only-hash";

type InMsg = { file: File };
type OutMsg =
  | { type: "progress"; loaded: number; total: number }
  | { type: "done"; v1: string; v0: string }
  | { type: "error"; message: string };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: OutMsg) => ctx.postMessage(m);

async function* streamChunks(
  file: File,
  onChunk: (n: number) => void,
): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) {
        onChunk(value.byteLength);
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

ctx.onmessage = async (e: MessageEvent<InMsg>) => {
  const { file } = e.data;
  try {
    const total = file.size;
    let loaded = 0;
    let lastPost = 0;
    const bump = (n: number) => {
      loaded += n / 2; // two passes share the bar
      const now = Date.now();
      if (now - lastPost > 100) {
        lastPost = now;
        post({ type: "progress", loaded, total });
      }
    };
    const v1 = await Hash.of(streamChunks(file, bump), {
      cidVersion: 1,
      rawLeaves: true,
    });
    const v0 = await Hash.of(streamChunks(file, bump), {
      cidVersion: 0,
      rawLeaves: false,
    });
    post({ type: "progress", loaded: total, total });
    post({ type: "done", v1, v0 });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
