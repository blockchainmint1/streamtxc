import { AwsClient } from "aws4fetch";
const r = process.env.AWS_REGION || "us-east-1";
const c = new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region: r, service: "medialive" });
async function g(p){ const res = await c.fetch(`https://medialive.${r}.amazonaws.com${p}`); return { status: res.status, body: await res.text() }; }
console.log("INPUT:", await g("/prod/inputs/5331143"));
console.log("CHANNEL:", await g("/prod/channels/4900431"));
