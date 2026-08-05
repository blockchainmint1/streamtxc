import { AwsClient } from "aws4fetch";
const region = "us-east-1";
const c = (svc) => new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region, service: svc });
const iid = "i-098f7c9b38a69033e";

async function ec2(params) {
  const r = await c("ec2").fetch(`https://ec2.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Version: "2016-11-15", ...params }).toString(),
  });
  return { status: r.status, body: await r.text() };
}

const st = await ec2({ Action: "DescribeInstanceStatus", "InstanceId.1": iid, IncludeAllInstances: "true" });
console.log("=== DescribeInstanceStatus", st.status, "===");
console.log(st.body.replace(/></g, ">\n<").split("\n").filter(l=>/Code|Name|Status|Description|impaired|reachability/i.test(l)).join("\n").slice(0,2000));

const co = await ec2({ Action: "GetConsoleOutput", InstanceId: iid });
console.log("\n=== GetConsoleOutput", co.status, "===");
const m = co.body.match(/<output>([\s\S]*?)<\/output>/);
if (m) {
  const txt = Buffer.from(m[1], "base64").toString("utf8");
  console.log("...tail...");
  console.log(txt.split("\n").slice(-70).join("\n"));
  const oom = txt.split("\n").filter(l => /Out of memory|oom-kill|Killed process|kernel panic|blocked for more than/i.test(l));
  console.log("\n=== OOM/panic lines ===\n" + (oom.slice(-25).join("\n") || "(none found)"));
} else console.log(co.body.slice(0, 800));
