import { createFileRoute } from "@tanstack/react-router";

/**
 * Admin endpoint: manually finalize the HLS pipeline for a single video
 * whose MediaConvert webhook never fired (or fired but failed to pin).
 * Mirrors finalizeOwnTranscode but with admin auth instead of wallet sig.
 *
 *   POST /api/public/admin/finalize-hls?cid=<videoCid>
 *   header: x-admin-token: <TXC_RPC_PASS>
 */
export const Route = createFileRoute("/api/public/admin/finalize-hls")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.TXC_RPC_PASS;
        const provided = request.headers.get("x-admin-token");
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }
        const cid = new URL(request.url).searchParams.get("cid");
        if (!cid) return new Response("Missing cid", { status: 400 });

        const outputBucket = process.env.AWS_S3_OUTPUT_BUCKET;
        if (!outputBucket) return new Response("Transcode not configured", { status: 503 });

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: v, error } = await supabaseAdmin
            .from("videos")
            .select("cid, transcode_job_id, hls_cid")
            .eq("cid", cid)
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!v) throw new Error("Video not found");
          if (v.hls_cid) {
            return Response.json({ ok: true, alreadyFinalized: true, hlsCid: v.hls_cid });
          }
          const jobId = v.transcode_job_id;
          if (!jobId) throw new Error("No transcode job recorded");

          const { listObjects, getObjectBlob } = await import("@/lib/aws-s3.server");
          const prefix = `hls/${cid}/`;
          const keys = await listObjects(outputBucket, prefix);
          if (keys.length === 0) throw new Error(`No HLS outputs at s3://${outputBucket}/${prefix}`);

          let pinned: { cid: string; size: number };
          const lambdaToken = process.env.IPFS_LAMBDA_TOKEN;
          const lambdaUrl = process.env.IPFS_LAMBDA_URL;
          const lambdaName = process.env.IPFS_LAMBDA_NAME;
          if (lambdaToken && (lambdaName || lambdaUrl)) {
            const { callPinLambda } = await import("@/lib/ipfs-lambda.functions");
            const json = await callPinLambda({ bucket: outputBucket, keys }, lambdaToken);
            if (!json.cid) throw new Error("Lambda /pin returned no cid");
            pinned = { cid: json.cid, size: json.totalBytes ?? 0 };
          } else {
            const { pinDirectoryToIPFS } = await import("@/lib/pinata.server");
            const files: Array<{ path: string; body: Blob; contentType?: string }> = [];
            for (const key of keys) {
              const blob = await getObjectBlob(outputBucket, key);
              files.push({
                path: key.slice(prefix.length),
                body: blob,
                contentType: blob.type || undefined,
              });
            }
            pinned = await pinDirectoryToIPFS(files, `hls-${cid}`);
          }

          const { finalizeHlsPin, renditionsFromKeys } = await import("@/lib/finalize-hls-pin.server");
          const renditions = renditionsFromKeys(keys, prefix);
          const finalized = await finalizeHlsPin({
            cid,
            jobId,
            hlsCid: pinned.cid,
            renditions,
          });

          return Response.json({
            ok: true,
            hlsCid: pinned.cid,
            keys: keys.length,
            rowsUpdated: finalized.rowsUpdated,
            metadataCid: finalized.metadataCid,
            metadataTx: finalized.metadataTx,
          });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          );
        }
      },
    },
  },
});