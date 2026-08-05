import { AwsClient } from "aws4fetch";
const region = "us-east-1";
const cw = new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region, service: "monitoring" });
const iid = "i-098f7c9b38a69033e";
const end = new Date(), start = new Date(Date.now() - 6*3600*1000);
const q = (id, metric, stat) => ({ Id: id, MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: metric, Dimensions: [{ Name: "InstanceId", Value: iid }] }, Period: 300, Stat: stat } });
const body = { StartTime: start.toISOString(), EndTime: end.toISOString(), MetricDataQueries: [
  q("cpu","CPUUtilization","Maximum"), q("netout","NetworkOut","Sum"), q("netin","NetworkIn","Sum"),
  q("sc","StatusCheckFailed","Maximum"), q("cbal","CPUCreditBalance","Minimum"), q("rops","EBSReadOps","Sum") ] };
const r = await cw.fetch(`https://monitoring.${region}.amazonaws.com/`, { method: "POST", headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "GraniteServiceVersion20100801.GetMetricData" }, body: JSON.stringify(body) });
const t = await r.text();
console.log("status", r.status);
try { const j = JSON.parse(t); for (const m of j.MetricDataResults ?? []) { const v = m.Values ?? []; console.log(m.Id, m.StatusCode, "n="+v.length, "last10:", v.slice(0,10).map(x=>Math.round(x*100)/100).join(", ")); if(m.Timestamps?.length) console.log("   newest ts", m.Timestamps[0], "oldest", m.Timestamps.at(-1)); } if(j.Messages?.length) console.log(j.Messages); } catch { console.log(t.slice(0,600)); }
