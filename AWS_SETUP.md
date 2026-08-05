# AWS MediaConvert + S3 setup for adaptive HLS transcoding

The transcode pipeline is OFF by default. When the env vars below aren't set,
uploads continue to work as a single MP4 pinned to the self-hosted IPFS node,
streamed directly). Once configured, every new upload also runs through
MediaConvert and gets a 3-rendition HLS bundle pinned to that node.

## 1. Two S3 buckets

- **Input bucket** (e.g. `txc-transcode-input`) — browser uploads originals here via presigned PUT URLs.
- **Output bucket** (e.g. `txc-transcode-output`) — MediaConvert writes HLS outputs here.

Lifecycle policy (recommended): expire both buckets after 7 days. Originals
are already pinned to IPFS; HLS outputs are pinned by the webhook. Neither
needs to live in S3 long-term.

## 2. IAM role for MediaConvert

Trust policy: `mediaconvert.amazonaws.com`.
Inline policy (least privilege):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject"],
      "Resource": "arn:aws:s3:::txc-transcode-input/*" },
    { "Effect": "Allow", "Action": ["s3:PutObject","s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::txc-transcode-output",
        "arn:aws:s3:::txc-transcode-output/*"
      ] }
  ]
}
```

Copy the role ARN — it becomes `AWS_MEDIACONVERT_ROLE_ARN`.

## 3. IAM user for our app

Create an IAM user with programmatic access and this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::txc-transcode-input/*" },
    { "Effect": "Allow", "Action": ["s3:GetObject","s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::txc-transcode-output",
        "arn:aws:s3:::txc-transcode-output/*"
      ] },
    { "Effect": "Allow", "Action": ["mediaconvert:CreateJob","mediaconvert:GetJob","mediaconvert:DescribeEndpoints"],
      "Resource": "*" },
    { "Effect": "Allow", "Action": "iam:PassRole",
      "Resource": "<role ARN from step 2>" }
  ]
}
```

Note the access key id + secret — they become `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.

## 4. Input bucket CORS (browser → S3 PUT)

```json
[
  { "AllowedOrigins": ["https://streamtxc.com","https://*.lovable.app","http://localhost:5173"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"] }
]
```

## 5. MediaConvert endpoint

MediaConvert exposes a per-account endpoint URL. Get it once with:

```
aws mediaconvert describe-endpoints --region us-east-1
```

That URL is `AWS_MEDIACONVERT_ENDPOINT`.

## 6. EventBridge → webhook

Create an EventBridge rule:

- **Source**: `aws.mediaconvert`
- **Detail type**: `MediaConvert Job State Change`
- **Filter**: `status in [COMPLETE, ERROR, CANCELED]`
- **Target**: API Destination
  - HTTP method: `POST`
  - Endpoint: `https://stream.texitcoin.org/api/public/hooks/mediaconvert`
  - Connection: API key, header `x-webhook-signature` with a static
    HMAC-SHA256 of the body. EventBridge can't HMAC dynamically, so the
    simplest path is to use a Lambda intermediary: EventBridge → Lambda →
    POST to our webhook with `x-webhook-signature: hmac_sha256(body, secret)`.
    A 10-line Node Lambda is enough.

The shared secret becomes `MEDIACONVERT_WEBHOOK_SECRET`.

## 7. Add these secrets in Lovable

| Secret | Source |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | step 3 |
| `AWS_SECRET_ACCESS_KEY` | step 3 |
| `AWS_REGION` | e.g. `us-east-1` |
| `AWS_S3_INPUT_BUCKET` | step 1 |
| `AWS_S3_OUTPUT_BUCKET` | step 1 |
| `AWS_MEDIACONVERT_ROLE_ARN` | step 2 |
| `AWS_MEDIACONVERT_ENDPOINT` | step 5 |
| `MEDIACONVERT_WEBHOOK_SECRET` | step 6 |

## 8. Cost (informational)

MediaConvert "Professional" tier (HEVC, 4K) is ~$0.03/min/output. We use
H.264 "Basic" at ~$0.0075/min/output. A 10-minute video × 3 renditions ≈
**$0.225/upload**. Self-hosted IPFS storage and transfer costs depend on usage.