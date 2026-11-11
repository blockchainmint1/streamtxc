/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { fetchGateway, pinFileToIPFS, withGatewayKey, serveGateway } from "./ipfs.server";

const originalFetch = globalThis.fetch;
const originalRead = process.env.IPFS_READ_KEY;
const originalWrite = process.env.IPFS_WRITE_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRead === undefined) delete process.env.IPFS_READ_KEY;
  else process.env.IPFS_READ_KEY = originalRead;
  if (originalWrite === undefined) delete process.env.IPFS_WRITE_KEY;
  else process.env.IPFS_WRITE_KEY = originalWrite;
});

test("downloads use only the read credential and preserve byte ranges", async () => {
  process.env.IPFS_READ_KEY = "fixture-read";
  process.env.IPFS_WRITE_KEY = "fixture-write";
  let matched = false;
  globalThis.fetch = (async (_url, init) => {
    const headers = new Headers(init?.headers);
    matched = headers.get("Authorization") === "Bearer fixture-read" && headers.get("Range") === "bytes=0-99";
    return new Response("ok");
  }) as typeof fetch;
  await fetchGateway("https://node.ipfs.honest.money/ipfs/fixture", { headers: { Range: "bytes=0-99" } });
  expect(matched).toBe(true);
});

test("private uploads use only the write credential", async () => {
  process.env.IPFS_READ_KEY = "fixture-read";
  process.env.IPFS_WRITE_KEY = "fixture-write";
  let matched = false;
  globalThis.fetch = (async (url, init) => {
    matched = url === "https://ipfs.honest.money/api/public/v1/upload" && new Headers(init?.headers).get("Authorization") === "Bearer fixture-write" && init?.method === "POST";
    return Response.json({ cid: "fixture-cid", size: 3 });
  }) as typeof fetch;
  await pinFileToIPFS(new Blob(["abc"]), "fixture.txt");
  expect(matched).toBe(true);
});

test("sharing links contain no stored credential", () => {
  process.env.IPFS_READ_KEY = "fixture-read";
  process.env.IPFS_WRITE_KEY = "fixture-write";
  expect(withGatewayKey("https://node.ipfs.honest.money/ipfs/fixture/file.vtt")).toBe("/api/stream/fixture/file.vtt");
});
test("downloads never follow redirects, using a mode Cloudflare supports", async () => {
  process.env.IPFS_READ_KEY = "fixture-read";
  let mode: RequestRedirect | undefined;
  globalThis.fetch = (async (_url, init) => {
    mode = init?.redirect;
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
  }) as typeof fetch;
  const res = await fetchGateway("https://node.ipfs.honest.money/ipfs/fixture");
  expect(mode).toBe("manual");
  expect(res.status).toBe(502);
});

test("HTML user files are downloaded inertly and cannot execute on the site", async () => {
  globalThis.fetch = (async () => new Response("<script>localStorage.clear()</script>", { headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
  const res = await serveGateway("https://node.ipfs.honest.money/ipfs/fixture", new Request("https://streamtxc.com/api/stream/fixture"), "no-store");
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition")).toBe("attachment");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toContain("sandbox;");
});
test("normal video ranges still stream with protection and no credentials", async () => {
  globalThis.fetch = (async () => new Response("segment", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-6/100", "set-cookie": "private=value" } })) as typeof fetch;
  const res = await serveGateway("https://node.ipfs.honest.money/ipfs/fixture", new Request("https://streamtxc.com/api/stream/fixture"), "no-store");
  expect(res.status).toBe(206);
  expect(res.headers.get("content-type")).toBe("video/mp4");
  expect(res.headers.get("content-range")).toBe("bytes 0-6/100");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(await res.text()).toBe("segment");
});
