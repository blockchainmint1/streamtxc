const { Readable } = require("stream");
const { createHmac } = require("crypto");
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
    if (route === "POST /add") return await addToNode(event);
    const body = JSON.parse(event.body || "{}");
    if (route === "POST /pin-by-hash") return await pinByHash(body);
    if (route === "POST /pin-cid") return await pinCidOnNode(body);
    return await pinFromS3(body);
  } catch (err) {
    console.error(err);
    return resp(500, { error: String(err?.message || err) });
  }
};

// POST /add — multipart upload of raw bytes straight into kubo.
async function addToNode(event) {
  if (!IPFS_API) return resp(503, { error: "IPFS_API not configured" });
  const ct = event.headers?.["content-type"] || event.headers?.["Content-Type"] || "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    return resp(400, { error: "Content-Type must be multipart/form-data" });
  }
  const qs = event.queryStringParameters || {};
  const wrap = qs.wrap === "1" || qs.wrap === "true";
  const raw = event.body
    ? (event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body, "utf8"))
    : Buffer.alloc(0);
  const url = `${IPFS_API}/api/v0/add?cid-version=1&raw-leaves=true&pin=true&progress=false${wrap ? "&wrap-with-directory=true" : ""}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": ct },
    body: raw,
  });
  if (!r.ok) {
    const t = await r.text();
    return resp(502, { ok: false, error: "ipfs add failed", status: r.status, body: t.slice(0, 1000) });
  }
  const text = await r.text();
  const entries = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const root = wrap
    ? (entries.find((e) => e.Name === "" || e.Name === "wrap") || entries[entries.length - 1])
    : entries[entries.length - 1];
  const totalBytes = entries.reduce((s, e) => s + Number(e.Size || 0), 0);
  return resp(200, {
    cid: root?.Hash,
    files: entries.length,
    totalBytes,
    manifest: entries
      .filter((e) => e.Hash && e.Hash !== root?.Hash)
      .map((e) => ({ path: e.Name || "", cid: e.Hash, size: Number(e.Size || 0) })),
  });
}

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
  let result;
  if (!ipfsRes.ok) {
    const t = await ipfsRes.text();
    result = { ok: false, error: "ipfs add failed", status: ipfsRes.status, body: t.slice(0, 1000) };
  } else {
    const text = await ipfsRes.text();
    const entries = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const root = entries.find((e) => e.Name === "wrap") || entries[entries.length - 1];
    result = {
      ok: true,
      cid: root?.Hash,
      files: sentFiles.length,
      totalBytes,
      manifest: entries
        .filter((e) => e.Name && e.Name !== "wrap" && e.Hash !== root?.Hash)
        .map((e) => ({ path: e.Name.replace(/^wrap\//, ""), cid: e.Hash, size: Number(e.Size || 0) })),
    };
  }

  // Optional async callback: when the caller passes callbackUrl + callbackSecret
  // (typical for the long-running HLS bundle pin invoked with X-Amz-Invocation-Type: Event),
  // POST the result back to our webhook with an HMAC signature so the app can
  // finalize the videos row without holding an open connection for the whole pin.
  if (body.callbackUrl && body.callbackSecret) {
    const payload = {
      cid: result.ok ? result.cid : null,
      files: result.files || 0,
      totalBytes: result.totalBytes || 0,
      manifest: result.manifest || [],
      error: result.ok ? null : (result.error || "pin failed"),
      meta: body.callbackMeta || {},
    };
    const bodyStr = JSON.stringify(payload);
    const sig = createHmac("sha256", body.callbackSecret).update(bodyStr).digest("hex");
    try {
      const cbRes = await fetch(body.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-signature": sig },
        body: bodyStr,
      });
      console.log(`callback → ${body.callbackUrl} : ${cbRes.status}`);
    } catch (e) {
      console.error("callback POST failed:", e);
    }
  }

  if (!result.ok) return resp(502, result);
  return resp(200, {
    cid: result.cid, files: result.files, totalBytes: result.totalBytes, manifest: result.manifest,
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

// Pin an already-existing CID on our self-hosted IPFS node via Kubo RPC.
// Used to mirror Pinata-pinned CIDs to honest.money.
async function pinCidOnNode(body) {
  if (!IPFS_API) return resp(503, { error: "IPFS_API not configured" });
  if (!body.cid) return resp(400, { error: "cid required" });
  const url = `${IPFS_API}/api/v0/pin/add?arg=${encodeURIComponent(body.cid)}&recursive=true&progress=false`;
  // Kubo's /pin/add blocks until the whole DAG is fetched, which can take
  // minutes for large CIDs and easily exceeds API Gateway's 30s timeout.
  // Race the request against a short timeout: if it finishes fast, return
  // the result; otherwise return 202 and let the node keep fetching in the
  // background (Kubo continues the pin even after the HTTP client drops).
  const controller = new AbortController();
  const SOFT_TIMEOUT_MS = 20000;
  const timer = setTimeout(() => controller.abort(), SOFT_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "POST", signal: controller.signal });
    clearTimeout(timer);
    const text = await r.text();
    return resp(r.ok ? 200 : 502, {
      ok: r.ok,
      status: r.status,
      response: safeJson(text),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      // Pin is still in progress on the node. Caller can poll /pin/ls later.
      return resp(202, {
        ok: true,
        queued: true,
        cid: body.cid,
        message: "pin started; still fetching on node",
      });
    }
    return resp(502, { ok: false, error: String(err?.message || err) });
  }
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
