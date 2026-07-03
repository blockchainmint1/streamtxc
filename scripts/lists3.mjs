import { AwsClient } from "aws4fetch";
const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  service: "s3",
});
const bucket = process.env.LIVE_ARCHIVE_BUCKET;
let token = null;
const all = [];
do {
  const url = new URL(`https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/`);
  url.searchParams.set("list-type","2");
  url.searchParams.set("prefix","txc-live");
  if (token) url.searchParams.set("continuation-token", token);
  const r = await aws.fetch(url);
  const t = await r.text();
  const keys = [...t.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m=>m[1]);
  const sizes = [...t.matchAll(/<Size>([^<]+)<\/Size>/g)].map(m=>Number(m[1]));
  const mods = [...t.matchAll(/<LastModified>([^<]+)<\/LastModified>/g)].map(m=>m[1]);
  for (let i=0;i<keys.length;i++) all.push({k:keys[i],s:sizes[i],m:mods[i]});
  const nt = t.match(/<NextContinuationToken>([^<]+)/);
  token = nt ? nt[1] : null;
} while (token);
// filter to segments after 2026-07-03 00:00
const rel = all.filter(o => o.k.endsWith(".ts") && o.m >= "2026-07-03T00:00:00").sort((a,b)=>a.k.localeCompare(b.k));
for (const o of rel) console.log(o.s, o.m, o.k);
console.log("count=", rel.length);
