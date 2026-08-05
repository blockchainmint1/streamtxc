import { AwsClient } from "aws4fetch";
const region = "us-east-1";
const cw = new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region, service: "monitoring" });
const iid = "i-098f7c9b38a69033e";
const end = new Date(), start = new Date(Date.now() - 12*3600*1000);
const p = new URLSearchParams({ Action: "GetMetricData", Version: "2010-08-01",
  StartTime: start.toISOString(), EndTime: end.toISOString(), ScanBy: "TimestampDescending" });
const metrics = [["cpu","CPUUtilization","Maximum"],["netout","NetworkOut","Sum"],["netin","NetworkIn","Sum"],
  ["sc","StatusCheckFailed","Maximum"],["scsys","StatusCheckFailed_System","Maximum"],["scinst","StatusCheckFailed_Instance","Maximum"],
  ["rb","EBSReadBytes","Sum"],["wb","EBSWriteBytes","Sum"]];
metrics.forEach(([id,name,stat],i)=>{ const n=i+1;
  p.set(`MetricDataQueries.member.${n}.Id`, id);
  p.set(`MetricDataQueries.member.${n}.MetricStat.Metric.Namespace`, "AWS/EC2");
  p.set(`MetricDataQueries.member.${n}.MetricStat.Metric.MetricName`, name);
  p.set(`MetricDataQueries.member.${n}.MetricStat.Metric.Dimensions.member.1.Name`, "InstanceId");
  p.set(`MetricDataQueries.member.${n}.MetricStat.Metric.Dimensions.member.1.Value`, iid);
  p.set(`MetricDataQueries.member.${n}.MetricStat.Period`, "300");
  p.set(`MetricDataQueries.member.${n}.MetricStat.Stat`, stat); });
const r = await cw.fetch(`https://monitoring.${region}.amazonaws.com/`, { method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"}, body: p.toString() });
const t = await r.text();
console.log("status", r.status);
if (!r.ok) { console.log(t.slice(0,700)); process.exit(0); }
for (const blk of t.split("<member>").slice(1)) {
  const id = blk.match(/<Id>(.*?)<\/Id>/)?.[1]; if(!id) continue;
  const vals = [...blk.matchAll(/<member>([\d.eE+-]+)<\/member>/g)].map(m=>parseFloat(m[1]));
  const ts = [...blk.matchAll(/<member>(\d{4}-\d\d-\d\dT[^<]+)<\/member>/g)].map(m=>m[1]);
  console.log(`\n${id}: points=${vals.length} newest=${ts[0]??"-"} oldest=${ts.at(-1)??"-"}`);
  console.log("  newest→older:", vals.slice(0,14).map(v=>v>10000?(v/1048576).toFixed(1)+"MB":Math.round(v*100)/100).join(" | "));
}
