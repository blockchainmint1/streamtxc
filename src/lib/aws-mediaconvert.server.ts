// AWS MediaConvert client — minimal Worker-compatible wrapper using aws4fetch.
// We deliberately avoid the official AWS SDK; it's huge and pulls in Node-only
// transport code that breaks under Cloudflare Workers / workerd.

import { AwsClient } from "aws4fetch";

function aws() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error(
      "AWS not configured: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION required",
    );
  }
  return new AwsClient({ accessKeyId, secretAccessKey, region, service: "mediaconvert" });
}

export interface CreateJobOpts {
  /** S3 input URI, e.g. s3://my-input/uploads/abc.mp4 */
  inputUri: string;
  /** S3 output prefix, e.g. s3://my-output/hls/<videoId>/ — trailing slash matters */
  outputPrefix: string;
  /** Opaque ID round-tripped via userMetadata so the webhook can find the video */
  videoId: string;
}

export interface MultiInputJobOpts {
  /** Ordered list of S3 URIs (e.g. .ts segments) — MediaConvert stitches them in order. */
  inputUris: string[];
  outputPrefix: string;
  /** Opaque tag round-tripped via userMetadata. For live archives we use `live-archive:<streamId>`. */
  videoId: string;
}

/**
 * Kick off a MediaConvert HLS job with a 3-rendition ABR ladder:
 *   720p @ 2.5 Mbps, 480p @ 1.2 Mbps, 360p @ 0.6 Mbps
 * Outputs land in `outputPrefix` as `master.m3u8` + per-rendition folders.
 * Returns the job id.
 */
export async function startHlsTranscode(opts: CreateJobOpts): Promise<{ jobId: string }> {
  const endpoint = process.env.AWS_MEDIACONVERT_ENDPOINT;
  const roleArn = process.env.AWS_MEDIACONVERT_ROLE_ARN;
  if (!endpoint || !roleArn) {
    throw new Error("AWS_MEDIACONVERT_ENDPOINT and AWS_MEDIACONVERT_ROLE_ARN required");
  }

  const body = {
    Role: roleArn,
    UserMetadata: { videoId: opts.videoId },
    Settings: {
      Inputs: [
        {
          FileInput: opts.inputUri,
          AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
          VideoSelector: {},
          TimecodeSource: "ZEROBASED",
        },
      ],
      OutputGroups: [
        {
          Name: "Apple HLS",
          OutputGroupSettings: {
            Type: "HLS_GROUP_SETTINGS",
            HlsGroupSettings: {
              Destination: opts.outputPrefix,
              SegmentLength: 6,
              MinSegmentLength: 0,
              ManifestDurationFormat: "INTEGER",
              OutputSelection: "MANIFESTS_AND_SEGMENTS",
            },
          },
          Outputs: [
            rendition("720p", 1280, 720, 2_500_000, 128_000),
            rendition("480p", 854, 480, 1_200_000, 96_000),
            rendition("360p", 640, 360, 600_000, 64_000),
          ],
        },
      ],
    },
  };

  const client = aws();
  const res = await client.fetch(`${endpoint.replace(/\/$/, "")}/2017-08-29/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MediaConvert createJob failed [${res.status}]: ${text}`);
  }
  const json = (await res.json()) as { job?: { id?: string } };
  if (!json.job?.id) throw new Error("MediaConvert returned no job id");
  return { jobId: json.job.id };
}

/**
 * Kick off an HLS ABR MediaConvert job with N stitched inputs. Used to
 * reassemble a live stream's archived .ts segments into a normal HLS asset.
 */
export async function startHlsTranscodeFromInputs(
  opts: MultiInputJobOpts,
): Promise<{ jobId: string }> {
  const endpoint = process.env.AWS_MEDIACONVERT_ENDPOINT;
  const roleArn = process.env.AWS_MEDIACONVERT_ROLE_ARN;
  if (!endpoint || !roleArn) {
    throw new Error("AWS_MEDIACONVERT_ENDPOINT and AWS_MEDIACONVERT_ROLE_ARN required");
  }
  if (opts.inputUris.length === 0) {
    throw new Error("startHlsTranscodeFromInputs: no inputs");
  }
  // MediaConvert has a per-job input cap (~150). If we exceed it, fail loud
  // rather than silently drop the tail of the stream.
  if (opts.inputUris.length > 150) {
    throw new Error(
      `startHlsTranscodeFromInputs: ${opts.inputUris.length} inputs exceeds MediaConvert cap of 150`,
    );
  }

  const body = {
    Role: roleArn,
    UserMetadata: { videoId: opts.videoId },
    Settings: {
      Inputs: opts.inputUris.map((uri) => ({
        FileInput: uri,
        AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
        VideoSelector: {},
        TimecodeSource: "ZEROBASED",
      })),
      OutputGroups: [
        {
          Name: "Apple HLS",
          OutputGroupSettings: {
            Type: "HLS_GROUP_SETTINGS",
            HlsGroupSettings: {
              Destination: opts.outputPrefix,
              SegmentLength: 6,
              MinSegmentLength: 0,
              ManifestDurationFormat: "INTEGER",
              OutputSelection: "MANIFESTS_AND_SEGMENTS",
            },
          },
          Outputs: [
            rendition("720p", 1280, 720, 2_500_000, 128_000),
            rendition("480p", 854, 480, 1_200_000, 96_000),
            rendition("360p", 640, 360, 600_000, 64_000),
          ],
        },
      ],
    },
  };

  const client = aws();
  const res = await client.fetch(`${endpoint.replace(/\/$/, "")}/2017-08-29/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MediaConvert createJob failed [${res.status}]: ${text}`);
  }
  const json = (await res.json()) as { job?: { id?: string } };
  if (!json.job?.id) throw new Error("MediaConvert returned no job id");
  return { jobId: json.job.id };
}

function rendition(
  name: string,
  width: number,
  height: number,
  videoBitrate: number,
  audioBitrate: number,
) {
  return {
    NameModifier: `-${name}`,
    VideoDescription: {
      Width: width,
      Height: height,
      ScalingBehavior: "DEFAULT",
      CodecSettings: {
        Codec: "H_264",
        H264Settings: {
          RateControlMode: "QVBR",
          MaxBitrate: videoBitrate,
          QvbrSettings: { QvbrQualityLevel: 7 },
          SceneChangeDetect: "TRANSITION_DETECTION",
          GopSize: 60,
          GopSizeUnits: "FRAMES",
          CodecProfile: "MAIN",
        },
      },
    },
    AudioDescriptions: [
      {
        CodecSettings: {
          Codec: "AAC",
          AacSettings: {
            Bitrate: audioBitrate,
            CodingMode: "CODING_MODE_2_0",
            SampleRate: 48000,
          },
        },
      },
    ],
    ContainerSettings: { Container: "M3U8", M3u8Settings: {} },
  };
}

export interface JobDescription {
  job?: {
    id?: string;
    status?: string;
    jobPercentComplete?: number;
    errorCode?: number;
    errorMessage?: string;
    createdAt?: string;
    timing?: { submitTime?: string; startTime?: string; finishTime?: string };
  };
}

/** Fetch the status/details of a MediaConvert job by id. */
export async function describeJob(jobId: string): Promise<JobDescription> {
  const endpoint = process.env.AWS_MEDIACONVERT_ENDPOINT;
  if (!endpoint) throw new Error("AWS_MEDIACONVERT_ENDPOINT required");
  const client = aws();
  const res = await client.fetch(
    `${endpoint.replace(/\/$/, "")}/2017-08-29/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET" },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`MediaConvert describeJob failed [${res.status}]: ${text}`);
  return JSON.parse(text) as JobDescription;
}