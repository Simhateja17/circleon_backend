#!/usr/bin/env bash
set -euo pipefail

# Deploy barsha-backend from your local machine to a GCP VM running PM2.
# Usage: VM_USER=barsha VM_IP=1.2.3.4 ./deploy.sh

VM_USER="${VM_USER:-barsha}"
VM_IP="${VM_IP:-}"
APP_DIR="/opt/barsha-backend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/google_compute_engine}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

if [[ -z "${VM_IP}" ]]; then
  echo "Error: VM_IP is not set. Example: VM_USER=barsha VM_IP=1.2.3.4 ./deploy.sh"
  exit 1
fi

if [[ -n "${SSH_KEY}" && -f "${SSH_KEY}" ]]; then
  SSH_OPTS="${SSH_OPTS} -i ${SSH_KEY}"
fi

echo "==> Deploying to ${VM_USER}@${VM_IP}"

# Sync backend code. .env and node_modules are excluded; install happens on the VM.
# Home-directory files under /opt/barsha-backend are protected because that path
# is also the barsha user's home directory.
# The deploy/gcp directory is kept because it contains ecosystem.config.js and Caddyfile.
RSYNC_RSH="ssh ${SSH_OPTS}" rsync -avz --delete \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.ssh' \
  --exclude='.bash*' \
  --exclude='.profile' \
  --exclude='.pm2' \
  --exclude='.npm' \
  "${BACKEND_DIR}/" "${VM_USER}@${VM_IP}:${APP_DIR}/"

# Install dependencies and reload the PM2 process.
ssh ${SSH_OPTS} "${VM_USER}@${VM_IP}" "cd ${APP_DIR} && npm ci --omit=dev && pm2 reload deploy/gcp/ecosystem.config.js"

echo "==> Deployment complete"
