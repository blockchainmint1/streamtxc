// Lets server routes opt into Cloudflare's `ctx.waitUntil` so background work
// (e.g. streaming a multi-GB import to Pinata) can outlive the HTTP response.
// Without this, returning a Response cancels any in-flight promises.
//
// `src/server.ts` wraps every request in runWithCfCtx(ctx, ...). Anywhere in
// the request call stack you can call `waitUntil(promise)` and Cloudflare
// keeps the isolate alive until that promise settles (subject to the usual
// CPU-time cap, which is fine for I/O-bound work like piping bytes).

import { AsyncLocalStorage } from "node:async_hooks";

interface CtxLike {
  waitUntil?: (p: Promise<unknown>) => void;
}

const als = new AsyncLocalStorage<{ ctx: CtxLike }>();

export function runWithCfCtx<T>(ctx: unknown, fn: () => Promise<T> | T): Promise<T> {
  const safe = (ctx && typeof ctx === "object" ? (ctx as CtxLike) : {}) ?? {};
  return Promise.resolve(als.run({ ctx: safe }, fn));
}

/**
 * Hand a promise to Cloudflare's waitUntil if available.
 * Returns true when the runtime accepted the background task; false when the
 * caller must keep the request open and await the work inline.
 */
export function waitUntil(p: Promise<unknown>): boolean {
  // In the Vite preview/dev runtime, a request context can expose a
  // waitUntil-shaped function without actually extending the request
  // lifetime. That makes long imports look queued while the promise gets
  // dropped immediately after the response finishes, leaving rows stuck at
  // `streaming` with 0 bytes forever. Force callers onto the inline fallback
  // in dev; production Worker requests still use the real runtime hook.
  if (import.meta.env.DEV) {
    void p;
    return false;
  }

  const store = als.getStore();
  const w = store?.ctx?.waitUntil;
  if (typeof w === "function") {
    try {
      w(p);
      return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}