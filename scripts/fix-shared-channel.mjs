import { AwsClient } from "aws4fetch";
const r = process.env.AWS_REGION || "us-east-1";
const c = new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region: r, service: "medialive" });
const base = `https://medialive.${r}.amazonaws.com/prod/channels/4668103`;
const ch = await (await c.fetch(base)).json();
if (ch.state !== "IDLE") { console.log("NOT IDLE:", ch.state); process.exit(1); }

const dest = ch.destinations.find(d => d.id === "s3-archive-dest");
dest.settings = [{ url: "s3://txc-live-archive-150646524089/txc-live/index" }];

const es = ch.encoderSettings;
const gi = es.outputGroups.findIndex(g => g.outputGroupSettings.archiveGroupSettings);
es.outputGroups[gi] = {
  name: "archive-to-s3-hls",
  outputGroupSettings: {
    hlsGroupSettings: {
      destination: { destinationRefId: "s3-archive-dest" },
      hlsCdnSettings: { hlsS3Settings: { numRetries: 5 } },
      mode: "VOD",
      outputSelection: "MANIFESTS_AND_SEGMENTS",
      segmentLength: 6,
      indexNSegments: 10,
      keepSegments: 21,
      manifestDurationFormat: "INTEGER",
      streamInfResolution: "INCLUDE",
      clientCache: "ENABLED",
      codecSpecification: "RFC_4281",
    },
  },
  outputs: [{
    outputName: "archive_720p",
    videoDescriptionName: "video_720p",
    audioDescriptionNames: ["audio_aac"],
    outputSettings: { hlsOutputSettings: { nameModifier: "_720p", hlsSettings: { standardHlsSettings: { audioRenditionSets: "program_audio", m3u8Settings: { audioFramesPerPes: 4, pcrControl: "PCR_EVERY_PES_PACKET" } } } } },
  }],
};

const res = await c.fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: ch.name, destinations: ch.destinations, encoderSettings: es, inputAttachments: ch.inputAttachments, inputSpecification: ch.inputSpecification, roleArn: ch.roleArn, logLevel: ch.logLevel }) });
console.log(res.status, (await res.text()).slice(0, 1200));
