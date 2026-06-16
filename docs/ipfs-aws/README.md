# AWS IPFS Cluster + Lambda Pinner — Setup Guide

Goal: stand up a private IPFS node on EC2 inside a VPC, plus a Lambda
(in the same VPC) that streams S3 → IPFS and returns a root CID. The
Cloudflare Worker (Lovable) calls that Lambda from the MediaConvert
webhook, then pins the CID to Pinata as backup, then writes to chain.

If you are using AWS CloudShell, use the one-shot script instead of
pasting individual README snippets. It creates the templates, deploys
the stacks, installs the IPFS gateway, and prints the values Lovable
needs at the end.

```bash
export S3_BUCKET=your-mediaconvert-output-bucket
bash txc-ipfs-deploy.sh
```

If you already copied the file into CloudShell, just run:

```bash
export S3_BUCKET=your-mediaconvert-output-bucket
bash txc-ipfs-deploy.sh
```

Total time: ~45 min the first time. Region used throughout:
**us-east-1** by default. Change with `export AWS_REGION=...` if your
S3 bucket is elsewhere.

---

## 0. Prerequisites

- AWS account with admin access
- AWS CLI installed locally and `aws configure` done
- Your S3 bucket name (the one MediaConvert writes HLS output to)
- Your AWS region (e.g. `us-east-1`)

Set these once in your shell — every later command reuses them:

```bash
export AWS_REGION=us-east-1
export S3_BUCKET=your-mediaconvert-output-bucket
export STACK=txc-ipfs
```

---

## 1. Network: VPC + subnets + security groups

If you already have a VPC you want to use, skip to step 1b and just
export the IDs. Otherwise, create a fresh one:

### 1a. Create VPC (only if you don't have one)

```bash
aws cloudformation deploy \
  --region $AWS_REGION \
  --stack-name ${STACK}-vpc \
  --template-file docs/ipfs-aws/terraform/01-vpc.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

Grab the outputs:

```bash
export VPC_ID=$(aws cloudformation describe-stacks --region $AWS_REGION \
  --stack-name ${STACK}-vpc --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text)
export PUBLIC_SUBNET=$(aws cloudformation describe-stacks --region $AWS_REGION \
  --stack-name ${STACK}-vpc --query "Stacks[0].Outputs[?OutputKey=='PublicSubnetId'].OutputValue" --output text)
export PRIVATE_SUBNET=$(aws cloudformation describe-stacks --region $AWS_REGION \
  --stack-name ${STACK}-vpc --query "Stacks[0].Outputs[?OutputKey=='PrivateSubnetId'].OutputValue" --output text)
```

### 1b. Use an existing VPC

```bash
export VPC_ID=vpc-xxxxxxxx
export PUBLIC_SUBNET=subnet-xxxxxxxx     # has internet gateway route
export PRIVATE_SUBNET=subnet-yyyyyyyy    # has NAT gateway route
```

---

## 2. EC2: IPFS (Kubo) node

Deploys a t3.medium running Kubo with 200GB EBS, swarm port 4001 open
to the internet (so the CID is discoverable on the public DHT — Pinata
needs this to back up), and API port 5001 locked to the Lambda's SG.

```bash
aws cloudformation deploy \
  --region $AWS_REGION \
  --stack-name ${STACK}-ipfs \
  --template-file docs/ipfs-aws/terraform/02-ipfs-node.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=$VPC_ID \
    PublicSubnetId=$PUBLIC_SUBNET
```

Wait ~5 min for it to come up, then grab outputs:

```bash
export IPFS_PRIVATE_IP=$(aws cloudformation describe-stacks --region $AWS_REGION \
  --stack-name ${STACK}-ipfs --query "Stacks[0].Outputs[?OutputKey=='PrivateIp'].OutputValue" --output text)
export IPFS_SG_ID=$(aws cloudformation describe-stacks --region $AWS_REGION \
  --stack-name ${STACK}-ipfs --query "Stacks[0].Outputs[?OutputKey=='SecurityGroupId'].OutputValue" --output text)
export IPFS_GATEWAY_DOMAIN=$(aws cloudformation describe-stacks --region $AWS_REGION \
  --stack-name ${STACK}-ipfs --query "Stacks[0].Outputs[?OutputKey=='PublicDns'].OutputValue" --output text)

echo "IPFS private API:    http://$IPFS_PRIVATE_IP:5001"
echo "IPFS public gateway: http://$IPFS_GATEWAY_DOMAIN:8080"
```

Test it (from your laptop — gateway port 8080 is public):

```bash
curl -I "http://$IPFS_GATEWAY_DOMAIN:8080/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
```

Should return 200. (That CID is IPFS's "hello world".)

---

## 3. Lambda: S3 → IPFS pinner

Builds the deployment zip, creates the Lambda in the VPC, and puts API
Gateway in front of it with bearer-token auth.

### 3a. Generate a bearer token (save it — you'll paste into Lovable later)

```bash
export IPFS_LAMBDA_TOKEN=$(openssl rand -hex 32)
echo "SAVE THIS TOKEN: $IPFS_LAMBDA_TOKEN"
```

### 3b. Build Lambda zip

```bash
cd docs/ipfs-aws/lambda
npm install --omit=dev
zip -r ../lambda.zip .
cd -
```

### 3c. Deploy Lambda + API Gateway

```bash
aws cloudformation deploy \
  --region $AWS_REGION \
  --stack-name ${STACK}-lambda \
  --template-file docs/ipfs-aws/terraform/03-lambda.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId=$VPC_ID \
    PrivateSubnetId=$PRIVATE_SUBNET \
    IpfsSecurityGroupId=$IPFS_SG_ID \
    IpfsPrivateIp=$IPFS_PRIVATE_IP \
    S3BucketName=$S3_BUCKET \
    BearerToken=$IPFS_LAMBDA_TOKEN

aws lambda update-function-code \
  --region $AWS_REGION \
  --function-name ${STACK}-pinner \
  --zip-file fileb://docs/ipfs-aws/lambda.zip

export IPFS_LAMBDA_URL=$(aws cloudformation describe-stacks --region $AWS_REGION \
  --stack-name ${STACK}-lambda --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

echo "SAVE THIS URL:   $IPFS_LAMBDA_URL"
echo "SAVE THIS TOKEN: $IPFS_LAMBDA_TOKEN"
```

### 3d. Smoke test

```bash
curl -X POST "$IPFS_LAMBDA_URL/pin" \
  -H "Authorization: Bearer $IPFS_LAMBDA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"bucket\":\"$S3_BUCKET\",\"prefix\":\"some/existing/folder/\"}"
```

Expected response:

```json
{ "cid": "bafy...", "files": 12, "totalBytes": 1234567 }
```

---

## 4. Hand the two values to Lovable

Paste these to me in chat:

1. `IPFS_LAMBDA_URL` (looks like `https://abc123.execute-api.us-east-1.amazonaws.com/prod`)
2. `IPFS_LAMBDA_TOKEN` (the hex string)
3. `IPFS_GATEWAY_DOMAIN` (the EC2 public DNS — for HLS playback)

I'll add the first two as secrets via `add_secret`, hardcode the
gateway domain into the player, and rewrite the MediaConvert webhook
to:

1. Call your Lambda → get CID (seconds, not 74s)
2. POST CID to Pinata `/pinning/pinByHash` (backup pin, instant)
3. Write CID + manifest to chain

---

## 5. Costs (rough monthly)

| Item | Cost |
|---|---|
| EC2 t3.medium 24/7 | ~$30 |
| 200GB gp3 EBS | ~$16 |
| NAT Gateway (if new VPC) | ~$32 |
| Lambda (per-invocation) | <$1 for typical use |
| API Gateway | <$1 |
| **Total** | **~$50–80/mo** |

You can drop NAT gateway cost by using a VPC endpoint for S3 (free)
— the Lambda only needs S3 + the EC2 node, both reachable without NAT
if you add an S3 gateway endpoint. The CFN template in step 1a already
includes it.

---

## 6. Troubleshooting

- **Lambda times out**: check it's in the same AZ as the EC2 node, or
  at least same VPC. CloudWatch Logs group: `/aws/lambda/${STACK}-pinner`.
- **Pinata `pinByHash` says "not found"**: your EC2 node isn't reachable
  on port 4001. Check the security group lets `0.0.0.0/0` in on 4001
  TCP+UDP. May take 5-10 min for the DHT to propagate.
- **Gateway returns blank**: try `curl http://$IPFS_GATEWAY_DOMAIN:8080/api/v0/id`
  — if that 404s, Kubo isn't running. SSH in via SSM (no key needed,
  IAM role attached): `aws ssm start-session --target <instance-id>` then
  `sudo systemctl status ipfs`.

---

Go to bed — paste me the 3 values when you're up.