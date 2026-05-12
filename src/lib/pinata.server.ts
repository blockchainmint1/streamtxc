// Pinata IPFS pinning client (server-only). Uses JWT auth.
// https://docs.pinata.cloud/api-reference/endpoint/upload-a-file

const PINATA_BASE = "https://uploads.pinata.cloud/v3";

export interface PinResult {
  cid: string;
  size: number;
  pinataId: string;
}

export async function pinFileToIPFS(
  file: Blob | File,
  filename: string,
): Promise<PinResult> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT is not configured");

  const form = new FormData();
  form.append("file", file, filename);
  form.append("network", "public");
  // Request CIDv1 (bafy…) instead of legacy CIDv0 (Qm…)
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const res = await fetch(`${PINATA_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata upload failed [${res.status}]: ${text}`);
  }

  const json = (await res.json()) as {
    data: { id: string; cid: string; size: number };
  };
  return {
    cid: json.data.cid,
    size: json.data.size,
    pinataId: json.data.id,
  };
}

export function gatewayUrl(cid: string): string {
  const domain = process.env.PINATA_GATEWAY_DOMAIN;
  if (domain) return `https://${domain}/ipfs/${cid}`;
  return `https://gateway.pinata.cloud/ipfs/${cid}`;
}