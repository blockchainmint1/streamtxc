// Encoder settings + related channel-create JSON used when provisioning a
// per-user MediaLive channel. Mirrors the CFN template in
// docs/ipfs-aws/terraform/04-medialive.yaml but converted to the JSON shape
// the MediaLive REST API expects (camelCase field names).

export function buildChannelDestinations(args: {
  mediaPackageChannelId: string;
  archiveBucket: string;
  archivePrefix: string; // e.g. `per-user/<wallet>`
}) {
  return [
    {
      id: "mediapackage-dest",
      mediaPackageSettings: [{ channelId: args.mediaPackageChannelId }],
      settings: [],
    },
    {
      id: "s3-archive-dest",
      mediaPackageSettings: [],
      settings: [
        // HLS output group writes `<basename>.m3u8` + variant manifests +
        // .ts segments under this basename. Downstream we find the master
        // manifest at `<archivePrefix>/index.m3u8`.
        { url: `s3://${args.archiveBucket}/${args.archivePrefix}/index` },
      ],
    },
  ];
}

const h264 = (qvbr: number, maxBitrate: number) => ({
  h264Settings: {
    rateControlMode: "QVBR",
    qvbrQualityLevel: qvbr,
    maxBitrate,
    gopSize: 2,
    gopSizeUnits: "SECONDS",
    profile: "MAIN",
    level: "H264_LEVEL_AUTO",
    adaptiveQuantization: "HIGH",
    lookAheadRateControl: "HIGH",
    framerateControl: "SPECIFIED",
    framerateNumerator: 30,
    framerateDenominator: 1,
    parControl: "SPECIFIED",
    parNumerator: 1,
    parDenominator: 1,
  },
});

export const ENCODER_SETTINGS = {
  timecodeConfig: { source: "EMBEDDED" },
  audioDescriptions: [
    {
      name: "audio_aac",
      audioSelectorName: "default",
      codecSettings: {
        aacSettings: {
          bitrate: 128000,
          codingMode: "CODING_MODE_2_0",
          sampleRate: 48000,
        },
      },
    },
  ],
  videoDescriptions: [
    {
      name: "video_720p",
      width: 1280,
      height: 720,
      respondToAfd: "NONE",
      sharpness: 50,
      scalingBehavior: "DEFAULT",
      codecSettings: h264(7, 2500000),
    },
    { name: "video_480p", width: 854, height: 480, codecSettings: h264(6, 1200000) },
    { name: "video_360p", width: 640, height: 360, codecSettings: h264(5, 600000) },
  ],
  outputGroups: [
    {
      name: "hls-to-mediapackage",
      outputGroupSettings: {
        mediaPackageGroupSettings: { destination: { destinationRefId: "mediapackage-dest" } },
      },
      outputs: [
        {
          outputName: "720p",
          videoDescriptionName: "video_720p",
          audioDescriptionNames: ["audio_aac"],
          outputSettings: { mediaPackageOutputSettings: {} },
        },
        {
          outputName: "480p",
          videoDescriptionName: "video_480p",
          audioDescriptionNames: ["audio_aac"],
          outputSettings: { mediaPackageOutputSettings: {} },
        },
        {
          outputName: "360p",
          videoDescriptionName: "video_360p",
          audioDescriptionNames: ["audio_aac"],
          outputSettings: { mediaPackageOutputSettings: {} },
        },
      ],
    },
    {
      // HLS-to-S3 archive: writes `index.m3u8` (master) + variant
      // manifests + .ts segments. We use HLS instead of the raw Archive
      // output group because MediaConvert can probe framerate/codec from
      // the HLS manifest, but not from raw MediaLive .ts segments (which
      // omit framerate metadata in the elementary stream and cause
      // MediaConvert error 1040 "Invalid frame rate: 0/1").
      name: "archive-to-s3-hls",
      outputGroupSettings: {
        hlsGroupSettings: {
          destination: { destinationRefId: "s3-archive-dest" },
          hlsCdnSettings: {
            hlsS3Settings: { numRetries: 5 },
          },
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
      outputs: [
        {
          outputName: "archive_720p",
          videoDescriptionName: "video_720p",
          audioDescriptionNames: ["audio_aac"],
          outputSettings: {
            hlsOutputSettings: {
              nameModifier: "_720p",
              hlsSettings: {
                standardHlsSettings: {
                  audioRenditionSets: "program_audio",
                  m3u8Settings: {
                    audioFramesPerPes: 4,
                    pcrControl: "PCR_EVERY_PES_PACKET",
                  },
                },
              },
            },
          },
        },
      ],
    },
  ],
} as const;

export const INPUT_SPECIFICATION = {
  codec: "AVC",
  resolution: "HD",
  maximumBitrate: "MAX_10_MBPS",
} as const;