const { Readable } = require("stream");
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const s3 = new S3Client({});
const IPFS_API = process.env.IPFS_API;
const BEARER = process.env.BEARER_TOKEN;
const PINATA_JWT = process.env.PINATA_JWT || "";

exports.handler = async (event) => {
  try {
    const route = event.routeKey || `${event.requestContext?.http?.method || "POST"} ${event.rawPath || "/pin"}`;
    if (route === "GET /health") {
      return resp(200, { ok: true, ipfs: IPFS_API ? "configured" : "missing", pinata: PINATA_JWT ? "configured" : "disabled" });
    }
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    if (auth !== `Bearer ${BEARER}`) return resp(401, { error: "unauthorized" });
    const body = JSON.parse(event.body || "{}");
    if (route === "POST /pin-by-hash") return await pinByHash(body);
    return await pinFromS3(body);
  } catch (err) {
    console.error(err);
    return resp(500, { error: String(err?.message || err) });
  }
};

async function pinFromS3(body) {
  const bucket = body.bucket;
  const prefix = body.prefix || "";
  const explicitKeys = Array.isArray(body.keys) ? body.keys : [];
  if (!bucket) return resp(400, { error: "bucket required" });

  const keys = explicitKeys.length ? explicitKeys : await listAll(bucket, prefix);
  if (!keys.length) return resp(400, { error: "no objects found", bucket, prefix });

  const boundary = "----TXCFormBoundary" + Math.random().toString(36).slice(2);
  let totalBytes = 0;
  const sentFiles = [];

  async function* multipartBody() {
    for (const key of keys) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      totalBytes += Number(obj.ContentLength || 0);
      const relPath = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
      const safePath = relPath.replace(/["\r\n]/g, "_").replace(/^\/+/, "");
      sentFiles.push(safePath);
      yield Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="wrap/${safePath}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      );
      for await (const chunk of obj.Body) yield chunk;
      yield Buffer.from("\r\n");
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }

  const ipfsRes = await fetch(`${IPFS_API}/api/v0/add?wrap-with-directory=true&cid-version=1&raw-leaves=true&pin=true&progress=false`, {
    method: "POST",
    body: Readable.from(multipartBody()),
    duplex: "half",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  if (!ipfsRes.ok) {
    const t = await ipfsRes.text();
    return resp(502, { error: "ipfs add failed", status: ipfsRes.status, body: t.slice(0, 1000) });
  }

  const text = await ipfsRes.text();
  const entries = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const root = entries.find((e) => e.Name === "wrap") || entries[entries.length - 1];
  return resp(200, {
    cid: root?.Hash,
    files: sentFiles.length,
    totalBytes,
    manifest: entries
      .filter((e) => e.Name && e.Name !== "wrap" && e.Hash !== root?.Hash)
      .map((e) => ({ path: e.Name.replace(/^wrap\//, ""), cid: e.Hash, size: Number(e.Size || 0) })),
  });
}

async function pinByHash(body) {
  if (!PINATA_JWT) return resp(400, { error: "PINATA_JWT not configured" });
  if (!body.cid) return resp(400, { error: "cid required" });
  const r = await fetch("https://api.pinata.cloud/pinning/pinByHash", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PINATA_JWT}` },
    body: JSON.stringify({ hashToPin: body.cid, pinataMetadata: body.metadata || undefined }),
  });
  const text = await r.text();
  return resp(r.ok ? 200 : 502, { ok: r.ok, status: r.status, response: safeJson(text) });
}

async function listAll(bucket, prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of r.Contents || []) {
      if (item.Key && !item.Key.endsWith("/")) out.push(item.Key);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch (e) {
    return t;
  }
}
