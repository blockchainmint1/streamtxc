// Server-only: queue an async HLS-bundle pin on the IPFS Lambda.
import { getRequest } from "@tanstack/react-start/server";

export async function kickHlsPinAsyncForJob(data: { cid: string; jobId: string }) {
    const token = process.env.IPFS_LAMBDA_TOKEN;
    const fnName = process.env.IPFS_LAMBDA_NAME;
    const callbackSecret = process.env.MEDIACONVERT_WEBHOOK_SECRET;
    const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
    const inputBucket = process.env.AWS_S3_INPUT_BUCKET;
    if (!token) throw new Error("IPFS_LAMBDA_TOKEN missing");
    if (!fnName) throw new Error("IPFS_LAMBDA_NAME missing — async pin requires direct Lambda invoke");
    if (!callbackSecret) throw new Error("MEDIACONVERT_WEBHOOK_SECRET missing — needed to sign the pin callback");
    if (!outputBucket) throw new Error("AWS_S3_OUTPUT_BUCKET missing");

    const prefix = `hls/${data.cid}/`;
    const { listObjects, copyObject } = await import("./aws-s3.server");
    let keys = await listObjects(outputBucket, prefix);
    if (keys.length === 0) throw new Error(`No HLS outputs at s3://${outputBucket}/${prefix}`);

    // Bundle the original input file inside the HLS wrap directory (mirrors
    // what the EventBridge webhook does), so the resulting CID contains
    // both `original` and the HLS ladder.
    if (inputBucket) {
      const dstKey = `${prefix}original`;
      try {
        await copyObject({
          srcBucket: inputBucket,
          srcKey: `inputs/${data.cid}`,
          dstBucket: outputBucket,
          dstKey,
        });
        keys = [dstKey, ...keys.filter((k) => k !== dstKey)];
      } catch (err) {
        console.warn(`[kickHlsPinAsync ${data.cid}] copy original failed:`, err);
      }
    }

    // Derive the callback URL from the request origin so this works in
    // preview + production without hardcoding hostnames.
    const origin = new URL(getRequest().url).origin;
    const callbackUrl = `${origin}/api/public/hooks/ipfs-pin-complete`;

    // Flip the DB row to a distinct "pinning" state so the UI can show
    // an accurate stage while we wait for the Lambda callback.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("videos")
      .update({ transcode_status: "pinning", transcode_error: null })
      .eq("cid", data.cid)
      .eq("transcode_job_id", data.jobId);

    const { invokeLambdaAsync } = await import("./aws-lambda.server");
    await invokeLambdaAsync(fnName, {
      routeKey: "POST /pin",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        bucket: outputBucket,
        keys,
        callbackUrl,
        callbackSecret,
        callbackMeta: { cid: data.cid, jobId: data.jobId, prefix },
      }),
    });

    return { ok: true, files: keys.length, callbackUrl };
}