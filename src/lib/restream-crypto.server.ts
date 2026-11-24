// Stream keys for other sites are stored encrypted (AES-GCM, key derived from
// SESSION_SECRET with a dedicated HKDF label) and only decrypted when they
// are written into the host's own AWS live channel.
const enc = new TextEncoder();

async function key(): Promise<CryptoKey> {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("Server is missing SESSION_SECRET");
  const base = await crypto.subtle.importKey("raw", enc.encode(s), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("streamtxc"), info: enc.encode("restream-stream-key-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sealStreamKey(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), enc.encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function openStreamKey(sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Unreadable stream key");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(), unb64(ct));
  return new TextDecoder().decode(pt);
}
