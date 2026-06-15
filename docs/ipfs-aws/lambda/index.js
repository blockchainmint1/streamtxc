/**
 * S3 -> IPFS pinner.
 *
 * POST /pin
 *   Authorization: Bearer <BEARER_TOKEN>
 *   { "bucket": "...", "prefix": "outputs/job-123/", "keys": ["...optional explicit list..."] }
 *
 * Response: { cid, files, totalBytes, manifest: [{ key, cid, size }] }
 *
 * The root CID is a UnixFS directory wrapping every file under `prefix`
 * (or every key in `keys` if provided). Relative paths inside the
 * directory mirror the S3 keys (with `prefix` stripped).
 */

const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const FormData = require("form-data");
const fetch = require("node-fetch");

const s3 = new S3Client({});
const IPFS_API = process.env.IPFS_API;          // http://10.x.x.x:5001
const BEARER   = process.env.BEARER_TOKEN;

exports.handler = async (event) => {
  try {
    // bearer auth
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    if (auth !== `Bearer ${BEARER}`) {
      return resp(401, { error: "unauthorized" });
    }

    const body = JSON.parse(event.body || "{}");
    const { bucket, prefix = "", keys: explicitKeys } = body;
    if (!bucket) return resp(400, { error: "bucket required" });

    // gather keys
    const keys = explicitKeys?.length ? explicitKeys : await listAll(bucket, prefix);
    if (!keys.length) return resp(400, { error: "no objects found", bucket, prefix });

    // build multipart: one file part per S3 object, streamed
    const form = new FormData();
    let totalBytes = 0;
    for (const key of keys) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const relPath = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
      // Kubo expects filepath form-data field; encode the relative path
      form.append("file", obj.Body, {
        filename: encodeURIComponent(`wrap/${relPath}`),
        contentType: "application/octet-stream",
        knownLength: obj.ContentLength,
      });
      totalBytes += obj.ContentLength || 0;
    }

    // POST to Kubo with wrap-with-directory so we get one root CID
    // cid-version=1 -> bafy... base32 CIDs (modern)
    // raw-leaves=true -> smaller, more efficient for HLS segments
    const url = `${IPFS_API}/api/v0/add?wrap-with-directory=true&cid-version=1&raw-leaves=true&pin=true&progress=false`;
    const ipfsRes = await fetch(url, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    if (!ipfsRes.ok) {
      const t = await ipfsRes.text();
      return resp(502, { error: "ipfs add failed", status: ipfsRes.status, body: t.slice(0, 500) });
    }

    // Response is newline-delimited JSON, one entry per file + one for the wrapping dir (empty Name)
    const text = await ipfsRes.text();
    const entries = text.trim().split("\n").map((l) => JSON.parse(l));
    const root = entries.find((e) => e.Name === "" || e.Name === "wrap" || e.Name === "/");
    const rootCid = root?.Hash || entries[entries.length - 1].Hash;

    const manifest = entries
      .filter((e) => e.Name && e.Name !== "wrap" && e.Hash !== rootCid)
      .map((e) => ({
        path: decodeURIComponent(e.Name).replace(/^wrap\//, ""),
        cid: e.Hash,
        size: Number(e.Size || 0),
      }));

    return resp(200, {
      cid: rootCid,
      files: manifest.length,
      totalBytes,
      manifest,
    });
  } catch (err) {
    console.error(err);
    return resp(500, { error: String(err?.message || err) });
  }
};

async function listAll(bucket, prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of r.Contents || []) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}