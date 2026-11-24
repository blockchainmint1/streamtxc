/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { HME_SITE, hmeRedirect, hmeProfileUpdateSchema, linkedHmeWallet, verifyHmeTicket } from "./hme-protocol";

// Only a fake, local fixture key is used here. Never print a live credential or ticket.
const fixtureKey = "local-hme-test-fixture-not-a-live-key";
const now = 1_792_425_600_000;
const memberId = "5b1f0c2e-7a44-4d8e-9c31-2f6a8d0e4b17";
const wallet = "TmmoqqhcfBZWRG8feCTE2c4N4BsADgwD1m";
async function ticket(overrides: Record<string, unknown> = {}) {
  const body = btoa(JSON.stringify({ iss: "honest.money", site: HME_SITE, minerId: memberId,
    email: "before@example.com", exp: now / 1000 + 120, nonce: "fixture-nonce", ...overrides }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(fixtureKey),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return body + "." + [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("HME site tickets and permanent identity", () => {
  test("changed email preserves the UUID lookup and the member's wallet", async () => {
    const links = new Map([[memberId, { wallet, status: "active" }]]);
    for (const email of ["before@example.com", "after@example.com", undefined]) {
      const verified = await verifyHmeTicket(await ticket({ email }), fixtureKey, now);
      expect(verified.minerId).toBe(memberId);
      expect(linkedHmeWallet(links.get(verified.minerId) ?? null)).toBe(wallet);
    }
  });
  test("unknown UUID cannot claim a member's wallet by email", async () => {
    const links = new Map([[memberId, { wallet, status: "active" }]]);
    const verified = await verifyHmeTicket(await ticket({ minerId: "00000000-0000-4000-8000-000000000001", email: "member@example.com" }), fixtureKey, now);
    expect(linkedHmeWallet(links.get(verified.minerId) ?? null)).toBeNull();
  });
  test("rejects another site's correctly signed ticket", async () => {
    await expect(verifyHmeTicket(await ticket({ site: "passage" }), fixtureKey, now)).rejects.toThrow();
  });
  test("rejects another issuer's correctly signed ticket", async () => {
    await expect(verifyHmeTicket(await ticket({ iss: "other.example" }), fixtureKey, now)).rejects.toThrow();
  });
  test("rejects invalid signatures", async () => {
    await expect(verifyHmeTicket(await ticket(), "wrong-fixture-key", now)).rejects.toThrow();
  });
  test("ticket lifetime is at most 120 seconds", async () => {
    await expect(verifyHmeTicket(await ticket({ exp: now / 1000 + 121 }), fixtureKey, now)).rejects.toThrow();
  });
  test("expired ticket is rejected", async () => {
    await expect(verifyHmeTicket(await ticket({ exp: now / 1000 }), fixtureKey, now)).rejects.toThrow();
  });
  test("blocked and banned members cannot sign in", () => {
    for (const status of ["blocked", "ban"]) expect(() => linkedHmeWallet({ wallet, status })).toThrow();
  });
  test("profile email change uses the same UUID and never accepts a wallet replacement", () => {
    expect(hmeProfileUpdateSchema.parse({ minerId: memberId, newEmail: "AFTER@example.com", wallet: "different" }))
      .toEqual({ minerId: memberId, newEmail: "after@example.com" });
    expect(hmeProfileUpdateSchema.safeParse({ minerId: "email@example.com" }).success).toBe(false);
  });
  test("redirect stays on streamTXC", () => {
    expect(hmeRedirect("/manage")).toBe("/manage");
    for (const url of ["//evil.example", "/\\evil.example", "https://evil.example"]) expect(hmeRedirect(url)).toBeNull();
  });
});