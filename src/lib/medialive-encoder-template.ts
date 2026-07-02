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
        { url: `s3://${args.archiveBucket}/${args.archivePrefix}` },
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
      name: "archive-to-s3",
      outputGroupSettings: {
        archiveGroupSettings: {
          destination: { destinationRefId: "s3-archive-dest" },
          rolloverInterval: 3600,
        },
      },
      outputs: [
        {
          outputName: "archive",
          videoDescriptionName: "video_720p",
          audioDescriptionNames: ["audio_aac"],
          outputSettings: {
            archiveOutputSettings: {
              nameModifier: "_archive",
              containerSettings: {
                m2tsSettings: {
                  audioBufferModel: "ATSC",
                  bufferModel: "MULTIPLEX",
                  rateMode: "CBR",
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