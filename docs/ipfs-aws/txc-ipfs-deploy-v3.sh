#!/usr/bin/env bash
# TXC IPFS AWS deploy — v3
#
# What this gives you when it finishes:
#   - A fresh VPC (or reuses one you point it at via $VPC_ID)
#   - A Kubo IPFS node on EC2 (t3.large default, 2TB EBS, Caddy + HTTPS)
#   - A Lambda in the same VPC that streams S3 → IPFS and returns a CID
#   - An HTTP API Gateway in front of the Lambda with:
#       POST /pin           (bearer auth, the main entrypoint)
#       POST /add           (bearer auth, multipart upload → kubo /api/v0/add)
#       POST /pin-by-hash   (bearer auth, proxies to Pinata if PINATA_JWT set)
#       POST /pin-cid       (bearer auth, pins an existing CID on our IPFS node)
#       GET  /health        (no auth, returns {ok:true})
#   - A CloudWatch log group with 30-day retention
#   - A deploy-output.env file in $WORKDIR with every value Lovable needs
#
# Re-running is safe. Stacks that already exist are reused; broken stacks
# (ROLLBACK_COMPLETE etc.) are deleted and recreated.
#
# Required:
#   export S3_BUCKET=your-mediaconvert-output-bucket
#
# Common overrides:
#   export AWS_REGION=us-east-1
#   export STACK=txc-ipfs
#   export INSTANCE_TYPE=t3.large
#   export EBS_GB=2000
#   export IPFS_DOMAIN=ipfs.honest.money
#   export VPC_ID=vpc-xxxx  PUBLIC_SUBNET=subnet-xxxx  PRIVATE_SUBNET=subnet-yyyy
#   export BEARER_TOKEN=...  # optional; otherwise existing Lambda token is reused
#   export PINATA_JWT=eyJ...   # optional, enables /pin-by-hash

set -Eeuo pipefail
trap 'echo ""; echo "❌ STOPPED at line $LINENO. Copy the last ~20 lines to Lovable."' ERR

AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-txc-ipfs}"
S3_BUCKET="${S3_BUCKET:-}"
IPFS_DOMAIN="${IPFS_DOMAIN:-ipfs.honest.money}"
EBS_GB="${EBS_GB:-2000}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.large}"
PINATA_JWT="${PINATA_JWT:-}"
VPC_ID="${VPC_ID:-}"
PUBLIC_SUBNET="${PUBLIC_SUBNET:-}"
PRIVATE_SUBNET="${PRIVATE_SUBNET:-}"
WORKDIR="$HOME/txc-ipfs"

echo "============================================================"
echo "TXC IPFS AWS deploy — v3"
echo "============================================================"
echo "Region:        $AWS_REGION"
echo "Stack prefix:  $STACK"
echo "Instance:      $INSTANCE_TYPE"
echo "Storage:       ${EBS_GB}GB"
echo "Gateway host:  $IPFS_DOMAIN"
echo "Pinata backup: $([ -n "$PINATA_JWT" ] && echo enabled || echo disabled)"
echo "Reuse VPC:     $([ -n "$VPC_ID" ] && echo "$VPC_ID" || echo "no (creating fresh)")"
echo ""

if [ -z "$S3_BUCKET" ] || [ "$S3_BUCKET" = "your-mediaconvert-output-bucket" ]; then
  read -r -p "Paste the S3 bucket MediaConvert writes to, then press Enter: " S3_BUCKET
fi
if [ -z "$S3_BUCKET" ]; then
  echo "S3 bucket is required." >&2
  exit 1
fi

export AWS_PAGER=""
mkdir -p "$WORKDIR/lambda"
cd "$WORKDIR"

echo "=== Checking AWS login..."
aws sts get-caller-identity --region "$AWS_REGION" >/dev/null

echo "=== Checking S3 bucket exists / is reachable..."
aws s3api head-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" >/dev/null

stack_status() {
  aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "$1" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true
}

cleanup_bad_stack() {
  local name="$1" status
  status="$(stack_status "$name")"
  while [[ "$status" == *IN_PROGRESS ]]; do
    echo "=== Waiting for in-progress stack: $name ($status)"
    sleep 15
    status="$(stack_status "$name")"
  done
  case "$status" in
    ROLLBACK_COMPLETE|CREATE_FAILED|DELETE_FAILED|UPDATE_ROLLBACK_FAILED)
      echo "=== Removing failed stack: $name ($status)"
      aws cloudformation delete-stack --region "$AWS_REGION" --stack-name "$name"
      aws cloudformation wait stack-delete-complete --region "$AWS_REGION" --stack-name "$name"
      ;;
    ""|None) ;;
    *) echo "=== Existing stack OK/reusable: $name ($status)" ;;
  esac
}

cleanup_bad_stack "${STACK}-lambda"
cleanup_bad_stack "${STACK}-node"
[ -z "$VPC_ID" ] && cleanup_bad_stack "${STACK}-vpc"

if [ -z "${BEARER_TOKEN:-}" ]; then
  EXISTING_LAMBDA_NAME="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-lambda" --query "Stacks[0].Outputs[?OutputKey=='LambdaName'].OutputValue" --output text 2>/dev/null || true)"
  if [ -n "$EXISTING_LAMBDA_NAME" ] && [ "$EXISTING_LAMBDA_NAME" != "None" ]; then
    BEARER_TOKEN="$(aws lambda get-function-configuration --region "$AWS_REGION" --function-name "$EXISTING_LAMBDA_NAME" --query 'Environment.Variables.BEARER_TOKEN' --output text 2>/dev/null || true)"
  fi
fi
if [ -n "${BEARER_TOKEN:-}" ] && [ "$BEARER_TOKEN" != "None" ]; then
  echo "Bearer token: reusing existing/provided token"
else
  BEARER_TOKEN="$(openssl rand -hex 32)"
  echo "Bearer token: generated new token"
fi

# ───────────────────────────────────────────────────────────────
# 01 VPC
# ───────────────────────────────────────────────────────────────
cat > 01-vpc.yaml <<'YAML'
AWSTemplateFormatVersion: "2010-09-09"
Description: TXC IPFS VPC (public + private subnets, NAT, S3 gateway endpoint)
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.42.0.0/16
      EnableDnsHostnames: true
      EnableDnsSupport: true
      Tags: [{ Key: Name, Value: txc-ipfs-vpc }]
  Igw: { Type: AWS::EC2::InternetGateway }
  IgwAttach:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties: { VpcId: !Ref Vpc, InternetGatewayId: !Ref Igw }
  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.1.0/24
      MapPublicIpOnLaunch: true
      AvailabilityZone: !Select [0, !GetAZs ""]
  PrivateSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.2.0/24
      AvailabilityZone: !Select [0, !GetAZs ""]
  PublicRt:
    Type: AWS::EC2::RouteTable
    Properties: { VpcId: !Ref Vpc }
  PublicRoute:
    Type: AWS::EC2::Route
    DependsOn: IgwAttach
    Properties:
      RouteTableId: !Ref PublicRt
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref Igw
  PublicAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties: { SubnetId: !Ref PublicSubnet, RouteTableId: !Ref PublicRt }
  NatEip:
    Type: AWS::EC2::EIP
    DependsOn: IgwAttach
    Properties: { Domain: vpc }
  Nat:
    Type: AWS::EC2::NatGateway
    Properties:
      AllocationId: !GetAtt NatEip.AllocationId
      SubnetId: !Ref PublicSubnet
  PrivateRt:
    Type: AWS::EC2::RouteTable
    Properties: { VpcId: !Ref Vpc }
  PrivateRoute:
    Type: AWS::EC2::Route
    Properties:
      RouteTableId: !Ref PrivateRt
      DestinationCidrBlock: 0.0.0.0/0
      NatGatewayId: !Ref Nat
  PrivateAssoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties: { SubnetId: !Ref PrivateSubnet, RouteTableId: !Ref PrivateRt }
  S3Endpoint:
    Type: AWS::EC2::VPCEndpoint
    Properties:
      VpcId: !Ref Vpc
      ServiceName: !Sub com.amazonaws.${AWS::Region}.s3
      VpcEndpointType: Gateway
      RouteTableIds: [!Ref PrivateRt, !Ref PublicRt]
Outputs:
  VpcId: { Value: !Ref Vpc }
  PublicSubnetId: { Value: !Ref PublicSubnet }
  PrivateSubnetId: { Value: !Ref PrivateSubnet }
YAML

# ───────────────────────────────────────────────────────────────
# 02 IPFS node (Kubo + Caddy + HTTPS, 1TB+ data disk)
# ───────────────────────────────────────────────────────────────
cat > 02-ipfs-node.yaml <<'YAML'
AWSTemplateFormatVersion: "2010-09-09"
Description: TXC Kubo IPFS gateway (Caddy HTTPS, SSM-managed)
Parameters:
  VpcId: { Type: AWS::EC2::VPC::Id }
  PublicSubnetId: { Type: AWS::EC2::Subnet::Id }
  InstanceType: { Type: String, Default: t3.large }
  DataVolumeSizeGb: { Type: Number, Default: 2000 }
  StorageMax: { Type: String, Default: 1800GB }
  IpfsDomain: { Type: String, Default: ipfs.honest.money }
Resources:
  IpfsSg:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: TXC IPFS node
      VpcId: !Ref VpcId
      SecurityGroupIngress:
        - { IpProtocol: tcp, FromPort: 4001, ToPort: 4001, CidrIp: 0.0.0.0/0 }
        - { IpProtocol: udp, FromPort: 4001, ToPort: 4001, CidrIp: 0.0.0.0/0 }
        - { IpProtocol: tcp, FromPort: 8080, ToPort: 8080, CidrIp: 0.0.0.0/0 }
        - { IpProtocol: tcp, FromPort: 80,   ToPort: 80,   CidrIp: 0.0.0.0/0 }
        - { IpProtocol: tcp, FromPort: 443,  ToPort: 443,  CidrIp: 0.0.0.0/0 }
      SecurityGroupEgress:
        - { IpProtocol: -1, CidrIp: 0.0.0.0/0 }
  IpfsRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - { Effect: Allow, Principal: { Service: ec2.amazonaws.com }, Action: sts:AssumeRole }
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  IpfsProfile:
    Type: AWS::IAM::InstanceProfile
    Properties: { Roles: [!Ref IpfsRole] }
  Instance:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: !Ref InstanceType
      SubnetId: !Ref PublicSubnetId
      SecurityGroupIds: [!Ref IpfsSg]
      IamInstanceProfile: !Ref IpfsProfile
      ImageId: "{{resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id}}"
      BlockDeviceMappings:
        - DeviceName: /dev/sda1
          Ebs: { VolumeSize: 20, VolumeType: gp3 }
      UserData:
        Fn::Base64:
          Fn::Sub: |
            #!/bin/bash
            set -euxo pipefail
            export DEBIAN_FRONTEND=noninteractive
            apt-get update
            apt-get install -y ca-certificates curl wget tar gnupg debian-keyring debian-archive-keyring apt-transport-https jq

            # Wait for the data EBS to attach
            DEVICE=""
            for i in $(seq 1 120); do
              DEVICE=$(lsblk -ndo NAME,TYPE | awk '$2=="disk"{print "/dev/"$1}' | grep -Ev '/dev/(nvme0n1|xvda|sda)$' | head -n1 || true)
              if [ -n "$DEVICE" ]; then break; fi
              sleep 2
            done
            test -n "$DEVICE"
            if ! blkid "$DEVICE"; then mkfs.ext4 -F "$DEVICE"; fi
            mkdir -p /var/lib/ipfs
            UUID=$(blkid -s UUID -o value "$DEVICE")
            grep -q "$UUID" /etc/fstab || echo "UUID=$UUID /var/lib/ipfs ext4 defaults,nofail 0 2" >> /etc/fstab
            mountpoint -q /var/lib/ipfs || mount /var/lib/ipfs

            # Install Kubo
            cd /tmp
            wget -q https://dist.ipfs.tech/kubo/v0.32.1/kubo_v0.32.1_linux-amd64.tar.gz
            tar -xzf kubo_v0.32.1_linux-amd64.tar.gz
            bash kubo/install.sh

            useradd -r -m -d /var/lib/ipfs -s /bin/bash ipfs || true
            chown -R ipfs:ipfs /var/lib/ipfs

            if [ ! -f /var/lib/ipfs/config ]; then
              sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs init --profile=server
            fi
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config Addresses.API "/ip4/0.0.0.0/tcp/5001"
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config Addresses.Gateway "/ip4/0.0.0.0/tcp/8080"
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["GET","POST","PUT","OPTIONS"]'
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Methods '["GET","HEAD","OPTIONS"]'
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config Datastore.StorageMax "${StorageMax}"
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config Routing.Type "auto"
            sudo -u ipfs IPFS_PATH=/var/lib/ipfs ipfs config Reprovider.Interval "12h"

            cat >/etc/systemd/system/ipfs.service <<'EOF'
            [Unit]
            Description=IPFS daemon
            After=network.target

            [Service]
            User=ipfs
            Environment=IPFS_PATH=/var/lib/ipfs
            ExecStart=/usr/local/bin/ipfs daemon --migrate=true
            Restart=always
            RestartSec=5
            LimitNOFILE=65536

            [Install]
            WantedBy=multi-user.target
            EOF
            systemctl daemon-reload
            systemctl enable --now ipfs

            # Caddy: HTTPS for $IpfsDomain, plus :443 with self-signed for IP-based fallback
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
            curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
            apt-get update
            apt-get install -y caddy
            cat >/etc/caddy/Caddyfile <<EOF
            ${IpfsDomain} {
              encode gzip
              reverse_proxy 127.0.0.1:8080
            }
            :80 {
              reverse_proxy 127.0.0.1:8080
            }
            EOF
            systemctl enable --now caddy || true
      Tags: [{ Key: Name, Value: txc-ipfs-node }]
  IpfsVolume:
    Type: AWS::EC2::Volume
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      AvailabilityZone: !GetAtt Instance.AvailabilityZone
      Size: !Ref DataVolumeSizeGb
      VolumeType: gp3
      Tags: [{ Key: Name, Value: txc-ipfs-data }]
  VolumeAttach:
    Type: AWS::EC2::VolumeAttachment
    Properties:
      Device: /dev/sdf
      InstanceId: !Ref Instance
      VolumeId: !Ref IpfsVolume
Outputs:
  InstanceId: { Value: !Ref Instance }
  PrivateIp: { Value: !GetAtt Instance.PrivateIp }
  PublicDns: { Value: !GetAtt Instance.PublicDnsName }
  PublicIp:  { Value: !GetAtt Instance.PublicIp }
  SecurityGroupId: { Value: !Ref IpfsSg }
YAML

# ───────────────────────────────────────────────────────────────
# 03 Lambda + API Gateway (POST /pin, POST /pin-by-hash, GET /health)
# ───────────────────────────────────────────────────────────────
cat > 03-lambda.yaml <<'YAML'
AWSTemplateFormatVersion: "2010-09-09"
Description: TXC IPFS pinner Lambda + HTTP API
Parameters:
  VpcId: { Type: AWS::EC2::VPC::Id }
  PrivateSubnetId: { Type: AWS::EC2::Subnet::Id }
  IpfsSecurityGroupId: { Type: AWS::EC2::SecurityGroup::Id }
  IpfsPrivateIp: { Type: String }
  S3BucketName: { Type: String }
  BearerToken: { Type: String, NoEcho: true }
  PinataJwt:   { Type: String, NoEcho: true, Default: "" }
Resources:
  LambdaSg:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: TXC IPFS pinner lambda
      VpcId: !Ref VpcId
      SecurityGroupEgress: [{ IpProtocol: -1, CidrIp: 0.0.0.0/0 }]
  IpfsIngressFromLambda:
    Type: AWS::EC2::SecurityGroupIngress
    Properties:
      GroupId: !Ref IpfsSecurityGroupId
      IpProtocol: tcp
      FromPort: 5001
      ToPort: 5001
      SourceSecurityGroupId: !Ref LambdaSg
  LogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /aws/lambda/txc-ipfs-pinner
      RetentionInDays: 30
  LambdaRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - { Effect: Allow, Principal: { Service: lambda.amazonaws.com }, Action: sts:AssumeRole }
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole
      Policies:
        - PolicyName: txc-s3-read
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: [s3:GetObject, s3:ListBucket]
                Resource:
                  - !Sub arn:aws:s3:::${S3BucketName}
                  - !Sub arn:aws:s3:::${S3BucketName}/*
  PinnerFn:
    Type: AWS::Lambda::Function
    DependsOn: LogGroup
    Properties:
      FunctionName: txc-ipfs-pinner
      Runtime: nodejs22.x
      Handler: index.handler
      Role: !GetAtt LambdaRole.Arn
      Timeout: 900
      MemorySize: 3008
      EphemeralStorage: { Size: 10240 }
      Environment:
        Variables:
          IPFS_API: !Sub "http://${IpfsPrivateIp}:5001"
          BEARER_TOKEN: !Ref BearerToken
          PINATA_JWT: !Ref PinataJwt
      VpcConfig:
        SecurityGroupIds: [!Ref LambdaSg]
        SubnetIds: [!Ref PrivateSubnetId]
      Code:
        ZipFile: |
          exports.handler = async () => ({ statusCode: 200, body: "placeholder" });
  Api:
    Type: AWS::ApiGatewayV2::Api
    Properties: { Name: txc-ipfs-pinner, ProtocolType: HTTP }
  Integration:
    Type: AWS::ApiGatewayV2::Integration
    Properties:
      ApiId: !Ref Api
      IntegrationType: AWS_PROXY
      IntegrationUri: !GetAtt PinnerFn.Arn
      PayloadFormatVersion: "2.0"
  RoutePin:
    Type: AWS::ApiGatewayV2::Route
    Properties: { ApiId: !Ref Api, RouteKey: "POST /pin",         Target: !Sub "integrations/${Integration}" }
  RouteAdd:
    Type: AWS::ApiGatewayV2::Route
    Properties: { ApiId: !Ref Api, RouteKey: "POST /add",         Target: !Sub "integrations/${Integration}" }
  RoutePinByHash:
    Type: AWS::ApiGatewayV2::Route
    Properties: { ApiId: !Ref Api, RouteKey: "POST /pin-by-hash", Target: !Sub "integrations/${Integration}" }
  RouteHealth:
    Type: AWS::ApiGatewayV2::Route
    Properties: { ApiId: !Ref Api, RouteKey: "GET /health",       Target: !Sub "integrations/${Integration}" }
  Stage:
    Type: AWS::ApiGatewayV2::Stage
    Properties: { ApiId: !Ref Api, StageName: prod, AutoDeploy: true }
  Permission:
    Type: AWS::Lambda::Permission
    Properties:
      FunctionName: !Ref PinnerFn
      Action: lambda:InvokeFunction
      Principal: apigateway.amazonaws.com
      SourceArn: !Sub "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*"
Outputs:
  ApiUrl:     { Value: !Sub "https://${Api}.execute-api.${AWS::Region}.amazonaws.com/prod" }
  LambdaName: { Value: !Ref PinnerFn }
  LambdaSgId: { Value: !Ref LambdaSg }
YAML

# ───────────────────────────────────────────────────────────────
# Lambda code: S3 → IPFS streamer, /pin /pin-by-hash /health
# ───────────────────────────────────────────────────────────────
cat > lambda/index.js <<'LAMBDAEOF'
const { Readable } = require("stream");
const { createHmac } = require("crypto");
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const s3 = new S3Client({});
const IPFS_API = process.env.IPFS_API;
const BEARER = process.env.BEARER_TOKEN;
const PINATA_JWT = process.env.PINATA_JWT || "";

exports.handler = async (event) => {
  try {
    const route = event.routeKey || `${event.requestContext?.http?.method || "POST"} ${event.rawPath || "/pin"}`;
    if (route === "GET /health") {
      return resp(200, { ok: true, ipfs: IPFS_API ? "configured" : "missing", pinata: PINATA_JWT ? "configured" : "disabled" });
    }
    const auth = event.headers?.authorization || event.headers?.Authorization || "";
    if (auth !== `Bearer ${BEARER}`) return resp(401, { error: "unauthorized" });
    const body = JSON.parse(event.body || "{}");
    if (route === "POST /pin-by-hash") return await pinByHash(body);
    if (route === "POST /pin-cid") return await pinCidOnNode(body);
    return await pinFromS3(body);
  } catch (err) {
    console.error(err);
    return resp(500, { error: String(err?.message || err) });
  }
};

// POST /add — multipart upload of raw bytes straight into kubo. Used by
// the app for everything that isn't a MediaConvert HLS bundle: thumbnails,
// JSON metadata, comment bodies, chain-stamp JSON, etc. The request body
// is multipart/form-data with one or more "file" parts; we forward it
// verbatim to /api/v0/add and return the resulting CID(s). When >1 part,
// the caller can ask us to wrap them in a directory via ?wrap=1.
async function addToNode(event) {
  if (!IPFS_API) return resp(503, { error: "IPFS_API not configured" });
  const ct = event.headers?.["content-type"] || event.headers?.["Content-Type"] || "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    return resp(400, { error: "Content-Type must be multipart/form-data" });
  }
  const qs = event.queryStringParameters || {};
  const wrap = qs.wrap === "1" || qs.wrap === "true";
  const raw = event.body
    ? (event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : Buffer.from(event.body, "utf8"))
    : Buffer.alloc(0);
  const url = `${IPFS_API}/api/v0/add?cid-version=1&raw-leaves=true&pin=true&progress=false${wrap ? "&wrap-with-directory=true" : ""}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": ct },
    body: raw,
  });
  if (!r.ok) {
    const t = await r.text();
    return resp(502, { ok: false, error: "ipfs add failed", status: r.status, body: t.slice(0, 1000) });
  }
  const text = await r.text();
  const entries = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // When wrap=true kubo emits a final entry with Name=="" (the wrap dir);
  // otherwise the root is just the last entry.
  const root = wrap
    ? (entries.find((e) => e.Name === "" || e.Name === "wrap") || entries[entries.length - 1])
    : entries[entries.length - 1];
  const totalBytes = entries.reduce((s, e) => s + Number(e.Size || 0), 0);
  return resp(200, {
    cid: root?.Hash,
    files: entries.length,
    totalBytes,
    manifest: entries
      .filter((e) => e.Hash && e.Hash !== root?.Hash)
      .map((e) => ({ path: e.Name || "", cid: e.Hash, size: Number(e.Size || 0) })),
  });
}

async function pinFromS3(body) {
  const bucket = body.bucket;
  const prefix = body.prefix || "";
  const explicitKeys = Array.isArray(body.keys) ? body.keys : [];
  if (!bucket) return resp(400, { error: "bucket required" });

  const keys = explicitKeys.length ? explicitKeys : await listAll(bucket, prefix);
  if (!keys.length) return resp(400, { error: "no objects found", bucket, prefix });

  const boundary = "----TXCFormBoundary" + Math.random().toString(36).slice(2);
  let totalBytes = 0;
  const sentFiles = [];

  async function* multipartBody() {
    for (const key of keys) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      totalBytes += Number(obj.ContentLength || 0);
      const relPath = prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
      const safePath = relPath.replace(/["\r\n]/g, "_").replace(/^\/+/, "");
      sentFiles.push(safePath);
      yield Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="wrap/${safePath}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      );
      for await (const chunk of obj.Body) yield chunk;
      yield Buffer.from("\r\n");
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }

  const ipfsRes = await fetch(`${IPFS_API}/api/v0/add?wrap-with-directory=true&cid-version=1&raw-leaves=true&pin=true&progress=false`, {
    method: "POST",
    body: Readable.from(multipartBody()),
    duplex: "half",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  let result;
  if (!ipfsRes.ok) {
    const t = await ipfsRes.text();
    result = { ok: false, error: "ipfs add failed", status: ipfsRes.status, body: t.slice(0, 1000) };
  } else {
    const text = await ipfsRes.text();
    const entries = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const root = entries.find((e) => e.Name === "wrap") || entries[entries.length - 1];
    result = {
      ok: true,
      cid: root?.Hash,
      files: sentFiles.length,
      totalBytes,
      manifest: entries
        .filter((e) => e.Name && e.Name !== "wrap" && e.Hash !== root?.Hash)
        .map((e) => ({ path: e.Name.replace(/^wrap\//, ""), cid: e.Hash, size: Number(e.Size || 0) })),
    };
  }

  // Optional async callback: when the caller passes callbackUrl + callbackSecret
  // (typical for the long-running HLS bundle pin invoked with X-Amz-Invocation-Type: Event),
  // POST the result back to our webhook with an HMAC signature so the app can
  // finalize the videos row without holding an open connection for the whole pin.
  if (body.callbackUrl && body.callbackSecret) {
    const payload = {
      cid: result.ok ? result.cid : null,
      files: result.files || 0,
      totalBytes: result.totalBytes || 0,
      manifest: result.manifest || [],
      error: result.ok ? null : (result.error || "pin failed"),
      meta: body.callbackMeta || {},
    };
    const bodyStr = JSON.stringify(payload);
    const sig = createHmac("sha256", body.callbackSecret).update(bodyStr).digest("hex");
    try {
      const cbRes = await fetch(body.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-signature": sig },
        body: bodyStr,
      });
      console.log(`callback → ${body.callbackUrl} : ${cbRes.status}`);
    } catch (e) {
      console.error("callback POST failed:", e);
    }
  }

  if (!result.ok) return resp(502, result);
  return resp(200, {
    cid: result.cid, files: result.files, totalBytes: result.totalBytes, manifest: result.manifest,
  });
}

async function pinByHash(body) {
  if (!PINATA_JWT) return resp(400, { error: "PINATA_JWT not configured" });
  if (!body.cid) return resp(400, { error: "cid required" });
  const r = await fetch("https://api.pinata.cloud/pinning/pinByHash", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PINATA_JWT}` },
    body: JSON.stringify({ hashToPin: body.cid, pinataMetadata: body.metadata || undefined }),
  });
  const text = await r.text();
  return resp(r.ok ? 200 : 502, { ok: r.ok, status: r.status, response: safeJson(text) });
}

// Pin an already-existing CID on our self-hosted IPFS node via Kubo RPC.
// Used to mirror Pinata-pinned CIDs to honest.money.
async function pinCidOnNode(body) {
  if (!IPFS_API) return resp(503, { error: "IPFS_API not configured" });
  if (!body.cid) return resp(400, { error: "cid required" });
  const url = `${IPFS_API}/api/v0/pin/add?arg=${encodeURIComponent(body.cid)}&recursive=true&progress=false`;
  const controller = new AbortController();
  const SOFT_TIMEOUT_MS = 20000;
  const timer = setTimeout(() => controller.abort(), SOFT_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: "POST", signal: controller.signal });
    clearTimeout(timer);
    const text = await r.text();
    return resp(r.ok ? 200 : 502, {
      ok: r.ok,
      status: r.status,
      response: safeJson(text),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      return resp(202, {
        ok: true,
        queued: true,
        cid: body.cid,
        message: "pin started; still fetching on node",
      });
    }
    return resp(502, { ok: false, error: String(err?.message || err) });
  }
}

async function listAll(bucket, prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of r.Contents || []) {
      if (item.Key && !item.Key.endsWith("/")) out.push(item.Key);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch (e) {
    return t;
  }
}
LAMBDAEOF

# ───────────────────────────────────────────────────────────────
# Deploy
# ───────────────────────────────────────────────────────────────
if [ -z "$VPC_ID" ]; then
  echo "=== Deploying VPC stack..."
  aws cloudformation deploy --region "$AWS_REGION" --stack-name "${STACK}-vpc" \
    --template-file 01-vpc.yaml --capabilities CAPABILITY_NAMED_IAM
  VPC_ID="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-vpc" --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" --output text)"
  PUBLIC_SUBNET="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-vpc" --query "Stacks[0].Outputs[?OutputKey=='PublicSubnetId'].OutputValue" --output text)"
  PRIVATE_SUBNET="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-vpc" --query "Stacks[0].Outputs[?OutputKey=='PrivateSubnetId'].OutputValue" --output text)"
else
  echo "=== Reusing VPC $VPC_ID (public=$PUBLIC_SUBNET, private=$PRIVATE_SUBNET)"
  : "${PUBLIC_SUBNET:?Set PUBLIC_SUBNET when reusing VPC}"
  : "${PRIVATE_SUBNET:?Set PRIVATE_SUBNET when reusing VPC}"
fi

echo "=== Deploying IPFS node stack..."
aws cloudformation deploy --region "$AWS_REGION" --stack-name "${STACK}-node" \
  --template-file 02-ipfs-node.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    PublicSubnetId="$PUBLIC_SUBNET" \
    InstanceType="$INSTANCE_TYPE" \
    DataVolumeSizeGb="$EBS_GB" \
    StorageMax="$((EBS_GB * 90 / 100))GB" \
    IpfsDomain="$IPFS_DOMAIN"

IPFS_INSTANCE_ID="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-node" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
IPFS_PRIVATE_IP="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-node" --query "Stacks[0].Outputs[?OutputKey=='PrivateIp'].OutputValue" --output text)"
IPFS_PUBLIC_DNS="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-node" --query "Stacks[0].Outputs[?OutputKey=='PublicDns'].OutputValue" --output text)"
IPFS_PUBLIC_IP="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-node" --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" --output text)"
IPFS_SG_ID="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-node" --query "Stacks[0].Outputs[?OutputKey=='SecurityGroupId'].OutputValue" --output text)"

echo "============================================================"
echo "DNS STEP — create this A record for HTTPS to work:"
echo "  Type:  A"
echo "  Name:  $(echo "$IPFS_DOMAIN" | awk -F. '{print $1}')"
echo "  Value: $IPFS_PUBLIC_IP"
echo "Caddy will auto-issue the cert once DNS resolves. Continuing..."
echo "============================================================"

echo "=== Deploying Lambda stack..."
aws cloudformation deploy --region "$AWS_REGION" --stack-name "${STACK}-lambda" \
  --template-file 03-lambda.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    PrivateSubnetId="$PRIVATE_SUBNET" \
    IpfsSecurityGroupId="$IPFS_SG_ID" \
    IpfsPrivateIp="$IPFS_PRIVATE_IP" \
    S3BucketName="$S3_BUCKET" \
    BearerToken="$BEARER_TOKEN" \
    PinataJwt="$PINATA_JWT"

LAMBDA_NAME="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-lambda" --query "Stacks[0].Outputs[?OutputKey=='LambdaName'].OutputValue" --output text)"
API_URL="$(aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name "${STACK}-lambda" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"

echo "=== Ensuring /pin-cid route exists..."
API_ID="$(aws cloudformation describe-stack-resource --region "$AWS_REGION" --stack-name "${STACK}-lambda" --logical-resource-id Api --query 'StackResourceDetail.PhysicalResourceId' --output text)"
INTEGRATION_ID="$(aws cloudformation describe-stack-resource --region "$AWS_REGION" --stack-name "${STACK}-lambda" --logical-resource-id Integration --query 'StackResourceDetail.PhysicalResourceId' --output text)"
PIN_CID_ROUTE_ID="$(aws apigatewayv2 get-routes --region "$AWS_REGION" --api-id "$API_ID" --query "Items[?RouteKey=='POST /pin-cid'].RouteId | [0]" --output text)"
if [ -n "$PIN_CID_ROUTE_ID" ] && [ "$PIN_CID_ROUTE_ID" != "None" ]; then
  aws apigatewayv2 update-route --region "$AWS_REGION" --api-id "$API_ID" --route-id "$PIN_CID_ROUTE_ID" --target "integrations/$INTEGRATION_ID" >/dev/null
else
  aws apigatewayv2 create-route --region "$AWS_REGION" --api-id "$API_ID" --route-key "POST /pin-cid" --target "integrations/$INTEGRATION_ID" >/dev/null
fi

echo "=== Publishing Lambda code..."
(cd lambda && zip -q -r ../function.zip index.js)
aws lambda update-function-code --region "$AWS_REGION" \
  --function-name "$LAMBDA_NAME" --zip-file fileb://function.zip --publish >/dev/null

# ───────────────────────────────────────────────────────────────
# Smoke tests
# ───────────────────────────────────────────────────────────────
echo ""
echo "=== Smoke tests"
set +e
echo "--- API /health"
curl -fsS "$API_URL/health" || echo "(API not ready yet — try again in a minute)"
echo ""
echo "--- IPFS gateway HEAD (hello-world CID)"
curl -fsS -I "http://$IPFS_PUBLIC_DNS:8080/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" | head -n 3 \
  || echo "(IPFS not ready yet — user-data still bootstrapping; retry in 3-5 min)"
set -e

# ───────────────────────────────────────────────────────────────
# Output
# ───────────────────────────────────────────────────────────────
cat > "$WORKDIR/deploy-output.env" <<EOF
# TXC IPFS deploy — generated $(date -u +%FT%TZ)
AWS_REGION=$AWS_REGION
VPC_ID=$VPC_ID
PUBLIC_SUBNET=$PUBLIC_SUBNET
PRIVATE_SUBNET=$PRIVATE_SUBNET
IPFS_INSTANCE_ID=$IPFS_INSTANCE_ID
IPFS_PRIVATE_IP=$IPFS_PRIVATE_IP
IPFS_PUBLIC_DNS=$IPFS_PUBLIC_DNS
IPFS_PUBLIC_IP=$IPFS_PUBLIC_IP
IPFS_LAMBDA_URL=$API_URL
IPFS_LAMBDA_TOKEN=$BEARER_TOKEN
IPFS_GATEWAY_DOMAIN=$IPFS_DOMAIN
IPFS_GATEWAY_FALLBACK=http://$IPFS_PUBLIC_DNS:8080
EOF

echo ""
echo "============================================================"
echo "DONE — give these values to Lovable"
echo "============================================================"
cat "$WORKDIR/deploy-output.env"
echo "============================================================"
echo "Saved to: $WORKDIR/deploy-output.env"
echo ""
echo "SSH-less shell into the IPFS node:"
echo "  aws ssm start-session --region $AWS_REGION --target $IPFS_INSTANCE_ID"
echo "Tail Lambda logs:"
echo "  aws logs tail /aws/lambda/$LAMBDA_NAME --region $AWS_REGION --follow"
echo "============================================================"