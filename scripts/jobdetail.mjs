import { AwsClient } from "aws4fetch";
const endpoint = process.env.AWS_MEDIACONVERT_ENDPOINT.replace(/\/$/,'');
const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  service: "mediaconvert",
});
const r = await aws.fetch(`${endpoint}/2017-08-29/jobs/${process.argv[2]}`);
const j = await r.json();
console.log(JSON.stringify(j.job?.settings?.inputs, null, 2));
console.log("--");
console.log("errCode", j.job?.errorCode, j.job?.errorMessage);
