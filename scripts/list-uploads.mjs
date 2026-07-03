import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
const s3 = new S3Client({ region: process.env.AWS_REGION });
const r = await s3.send(new ListObjectsV2Command({ Bucket: process.env.AWS_S3_INPUT_BUCKET, Prefix: "uploads/", MaxKeys: 20 }));
const items = (r.Contents ?? []).sort((a,b) => new Date(b.LastModified) - new Date(a.LastModified)).slice(0, 10);
for (const o of items) console.log(o.LastModified?.toISOString(), (o.Size/1e6).toFixed(1)+"MB", o.Key);
