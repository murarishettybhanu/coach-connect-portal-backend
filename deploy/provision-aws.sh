#!/usr/bin/env bash
# One-time AWS provisioning for the ShipKit stack via Docker (AWS equivalent of
# provision.sh). Creates a security group, an EC2 instance with Docker installed
# (via user-data), and a stable Elastic IP. The Docker images, docker-compose.yml,
# Caddyfile and GitHub Actions CD are shared with the GCP setup — only the VM
# differs, so after this you follow the same deploy/README.md steps.
#
# Prereqs: AWS CLI v2 configured (`aws configure`) with credentials + a region.
# Usage:
#   REGION=ap-south-1 INSTANCE_TYPE=t3.small ./deploy/provision-aws.sh
set -euo pipefail

REGION="${REGION:-ap-south-1}"            # Mumbai
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.micro}" # 2 vCPU / 1GB — free-tier eligible (+2G swap below)
NAME="${NAME:-shipkit-vm}"
KEY_NAME="${KEY_NAME:-shipkit-key}"
DISK_SIZE="${DISK_SIZE:-20}"              # GB
SG_NAME="${SG_NAME:-shipkit-web}"
MY_IP="$(curl -fsS https://checkip.amazonaws.com 2>/dev/null || echo 0.0.0.0)"

export AWS_DEFAULT_REGION="$REGION"
echo "==> Region: $REGION   Instance: $INSTANCE_TYPE"

# 1) Key pair — create if missing (private key saved locally, chmod 600).
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "==> Creating key pair '$KEY_NAME' -> ./$KEY_NAME.pem"
  aws ec2 create-key-pair --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text > "$KEY_NAME.pem"
  chmod 600 "$KEY_NAME.pem"
fi

# 2) Security group — SSH from your IP only, HTTP/HTTPS from the world.
SG_ID="$(aws ec2 describe-security-groups --group-names "$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  echo "==> Creating security group '$SG_NAME'"
  SG_ID="$(aws ec2 create-security-group --group-name "$SG_NAME" \
    --description "ShipKit web" --query 'GroupId' --output text)"
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${MY_IP}/32,Description=ssh}]" \
    "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]" \
    "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]"
fi
echo "==> Security group: $SG_ID"

# 3) Latest Ubuntu 24.04 AMI for this region (Canonical's public SSM parameter).
AMI_ID="$(aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)"
echo "==> AMI: $AMI_ID"

# 4) user-data: install Docker + create /opt/shipkit (matches the GCP startup script).
USER_DATA="$(cat <<'EOF'
#!/bin/bash
set -e
# 2GB swap — keeps a 1GB t3.micro from OOMing under bursts / any on-box build.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker ubuntu || true
fi
mkdir -p /opt/shipkit
touch /opt/shipkit/.env
EOF
)"

# 5) Launch the instance.
echo "==> Launching $NAME"
IID="$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${DISK_SIZE},VolumeType=gp3}" \
  --user-data "$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)"
echo "==> Instance $IID — waiting to reach 'running'…"
aws ec2 wait instance-running --instance-ids "$IID"

# 6) Elastic IP — a stable address for the Atlas allowlist + DNS.
ALLOC="$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)"
aws ec2 associate-address --instance-id "$IID" --allocation-id "$ALLOC" >/dev/null
EIP="$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)"

cat <<NEXT

==> Done.
  Instance : $IID
  Public IP: $EIP   (Elastic — add this to your MongoDB Atlas IP allowlist)
  SSH      : ssh -i $KEY_NAME.pem ubuntu@$EIP

Next steps (same as deploy/README.md, just this host):
  1) Copy infra files up:
       scp -i $KEY_NAME.pem deploy/docker-compose.yml deploy/Caddyfile ubuntu@$EIP:/tmp/
       ssh -i $KEY_NAME.pem ubuntu@$EIP "sudo mv /tmp/docker-compose.yml /tmp/Caddyfile /opt/shipkit/"
  2) GitHub repo secrets (backend + frontend):
       SSH_HOST=$EIP   SSH_USER=ubuntu   SSH_PRIVATE_KEY=<contents of $KEY_NAME.pem>
       MONGODB_URI=…   JWT_SECRET=…   (SITE_ADDRESS=your-domain for automatic HTTPS)
  3) Push to main → CI builds images, pushes to GHCR, and deploys over SSH.

  Manual alternative (no CI): on the box, write /opt/shipkit/.env then
       cd /opt/shipkit && sudo docker compose up -d
NEXT
