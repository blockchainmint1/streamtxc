// Direct AWS Lambda Invoke via aws4fetch (SigV4). Used to bypass the
// 30-second API Gateway HTTP API timeout — direct Lambda invocations
// can run for the full 15 minutes the function is configured for.
//
// Required env:
//   AWS_REGION
//   AWS_ACCESS_KEY_ID
//   AWS_SECRET_ACCESS_KEY
//   (optional) AWS_SESSION_TOKEN

import { AwsClient } from "aws4fetch";

function client() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const region = process.env.AWS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error("AWS credentials missing (AWS_ACCESS_KEY_ID/SECRET/REGION)");
  }
  return new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken,
    region,
    service: "lambda",
  });
}

/**
 * Synchronously invoke a Lambda function with a JSON event payload.
 * Returns the function's raw response (already JSON-parsed).
 * Throws on Lambda error or non-2xx invoke status.
 */
export async function invokeLambda<T = unknown>(
  functionName: string,
  event: unknown,
  opts: { logType?: "None" | "Tail" } = {},
): Promise<T> {
  const region = process.env.AWS_REGION;
  const url = `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(
    functionName,
  )}/invocations`;

  const aws = client();
  const res = await aws.fetch(url, {
    method: "POST",
    headers: {
      "X-Amz-Invocation-Type": "RequestResponse",
      "X-Amz-Log-Type": opts.logType ?? "None",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lambda invoke HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  // If the function itself threw, AWS sets this header to "Unhandled".
  const funcErr = res.headers.get("x-amz-function-error");
  if (funcErr) {
    throw new Error(`Lambda function error (${funcErr}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Lambda returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Invoke a Lambda that follows the API Gateway response shape
 * `{ statusCode, headers, body }`, parse the body, and throw on non-2xx
 * status. This is what the txc-ipfs-pinner Lambda returns.
 */
export async function invokeApiGatewayLambda<T = unknown>(
  functionName: string,
  event: {
    routeKey: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<T> {
  const result = await invokeLambda<{
    statusCode: number;
    body?: string;
    headers?: Record<string, string>;
  }>(functionName, event);
  const statusCode = result?.statusCode ?? 0;
  const body = result?.body ?? "";
  let parsed: unknown = body;
  try { parsed = JSON.parse(body); } catch { /* keep raw */ }
  if (statusCode < 200 || statusCode >= 300) {
    const detail =
      typeof parsed === "string"
        ? parsed
        : JSON.stringify(parsed).slice(0, 500);
    throw new Error(`Lambda returned ${statusCode}: ${detail}`);
  }
  return parsed as T;
}