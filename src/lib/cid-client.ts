export type ComputedCids = { v1: string; v0: string };

export async function computeCids(file: File): Promise<ComputedCids> {
  const form = new FormData();
  form.append("file", file, file.name || "video");

  const res = await fetch("/api/public/cid", {
    method: "POST",
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as {
    v1?: string;
    v0?: string;
    error?: string;
  };

  if (!res.ok || !json.v1 || !json.v0) {
    throw new Error(json.error || `CID hashing failed (${res.status})`);
  }

  return { v1: json.v1, v0: json.v0 };
}