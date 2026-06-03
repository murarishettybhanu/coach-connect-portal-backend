#!/usr/bin/env bash
# One-time GCP provisioning for the ShipKit VM.
# Creates a small Compute Engine VM with Docker + Docker Compose, opens HTTP/HTTPS,
# and lays down /opt/shipkit (docker-compose.yml + Caddyfile + empty .env).
#
# Usage:
#   PROJECT=project-ed393033-4d39-4f83-820 ZONE=asia-south1-c ./provision.sh
set -euo pipefail

PROJECT="${PROJECT:-project-ed393033-4d39-4f83-820}"
ZONE="${ZONE:-asia-south1-c}"          # Mumbai
REGION="${REGION:-${ZONE%-*}}"
VM_NAME="${VM_NAME:-shipkit-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-small}"   # 2 vCPU (shared) / 2GB — ~US$13/mo
DISK_SIZE="${DISK_SIZE:-20GB}"

gcloud config set project "$PROJECT"

echo "==> Enabling Compute Engine API"
gcloud services enable compute.googleapis.com

echo "==> Creating firewall rules (http/https)"
gcloud compute firewall-rules create shipkit-allow-web \
  --direction=INGRESS --action=ALLOW --rules=tcp:80,tcp:443 \
  --target-tags=shipkit --quiet || true

echo "==> Creating VM $VM_NAME in $ZONE"
gcloud compute instances create "$VM_NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size="$DISK_SIZE" \
  --tags=shipkit \
  --metadata=startup-script='#!/bin/bash
set -e
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
mkdir -p /opt/shipkit
touch /opt/shipkit/.env
'

echo
echo "==> VM created. External IP:"
gcloud compute instances describe "$VM_NAME" --zone="$ZONE" \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)"

cat <<'NEXT'

Next steps:
  1) Copy the infra files onto the VM:
       gcloud compute scp deploy/docker-compose.yml deploy/Caddyfile \
         shipkit-vm:/tmp/ --zone=ZONE
       gcloud compute ssh shipkit-vm --zone=ZONE --command \
         "sudo mv /tmp/docker-compose.yml /tmp/Caddyfile /opt/shipkit/"
  2) Create an SSH key for GitHub Actions and add the public key to the VM
     (gcloud compute ssh once to auto-create, or add via project metadata).
  3) Put the VM's external IP + SSH key into GitHub secrets (see deploy/README.md).
  4) Push to main — the workflows build images, push to GHCR, and deploy.
NEXT
