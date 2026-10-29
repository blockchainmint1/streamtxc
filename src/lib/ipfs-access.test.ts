/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import { fetchGateway, pinFileToIPFS, withGatewayKey } from "./ipfs.server";

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