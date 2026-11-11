// Server-only: detailed IPFS Lambda health probe. Callers must redact before
// returning anything to a browser.
export async function probeIpfsLambdaHealth() {
  {
    const fnName = process.env.IPFS_LAMBDA_NAME;
    if (fnName && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_REGION) {
      try {
        const { invokeApiGatewayLambda } = await import("./aws-lambda.server");
        const body = await invokeApiGatewayLambda<unknown>(fnName, {
          routeKey: "GET /health",
          headers: {},
        });
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(body).slice(0, 500),
          transport: "direct-invoke",
        };
      } catch (err) {
        return {
          ok: false,
          status: 0,
          body: "",
          transport: "direct-invoke",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const url = process.env.IPFS_LAMBDA_URL;
    if (!url) {
      return {
        ok: false,
        status: 0,
        body: "",
        transport: "none",
        reason: "Neither IPFS_LAMBDA_NAME (+AWS creds) nor IPFS_LAMBDA_URL set",
      };
    }
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`);
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        body: text.slice(0, 500),
        transport: "api-gateway",
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        body: "",
        transport: "api-gateway",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

