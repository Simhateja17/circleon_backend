#!/usr/bin/env bash
set -euo pipefail

# Deploy barsha-backend from your local machine to a GCP VM running PM2.
# Usage: VM_USER=barsha VM_IP=1.2.3.4 ./deploy.sh

VM_USER="${VM_USER:-barsha}"
VM_IP="${VM_IP:-}"
APP_DIR="/opt/barsha-backend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${VM_IP}" ]]; then
  echo "Error: VM_IP is not set. Example: VM_USER=barsha VM_IP=1.2.3.4 ./deploy.sh"
  exit 1
fi

echo "==> Deploying to ${VM_USER}@${VM_IP}"

# Sync backend code. .env and node_modules are excluded; install happens on the VM.
# The deploy/gcp directory is kept because it contains ecosystem.config.js and Caddyfile.
rsync -avz --delete \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='.git' \
  "${BACKEND_DIR}/" "${VM_USER}@${VM_IP}:${APP_DIR}/"

# Install dependencies and reload the PM2 process.
ssh "${VM_USER}@${VM_IP}" "cd ${APP_DIR} && npm ci --omit=dev && pm2 reload ecosystem.config.js --env production"

echo "==> Deployment complete"
