import { AwsClient } from "aws4fetch";
const endpoint = process.env.AWS_MEDIACONVERT_ENDPOINT.replace(/\/$/,'');
const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  service: "mediaconvert",
});
for (const jobId of process.argv.slice(2)) {
  const r = await aws.fetch(`${endpoint}/2017-08-29/jobs/${encodeURIComponent(jobId)}`);
  const j = await r.json();
  const job = j.job || {};
  console.log(jobId, '→', job.status, 'pct=', job.jobPercentComplete, 'errCode=', job.errorCode, 'err=', (job.errorMessage||'').slice(0,200), 'finish=', job.timing?.finishTime);
}
