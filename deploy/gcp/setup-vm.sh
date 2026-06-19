#!/usr/bin/env bash
set -euo pipefail

# GCP VM setup script for barsha-backend.
# Run this as root (or with sudo) on a fresh Debian/Ubuntu VM.

APP_DIR="/opt/barsha-backend"
DATA_DIR="/var/lib/barsha-backend"
DOMAIN="${DOMAIN:-}"        # e.g. api.example.com
EMAIL="${EMAIL:-}"          # for Caddy Let's Encrypt notifications

echo "==> Updating packages"
apt-get update
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release rsync

echo "==> Installing Docker"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Installing Caddy"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

echo "==> Creating app directories"
mkdir -p "${APP_DIR}" "${DATA_DIR}"

echo "==> Copying Caddy config"
if [[ -n "${DOMAIN}" ]]; then
  sed -e "s/{{DOMAIN}}/${DOMAIN}/g" \
      -e "s/{{EMAIL}}/${EMAIL}/g" \
      "${APP_DIR}/deploy/gcp/Caddyfile" > /etc/caddy/Caddyfile
else
  cp "${APP_DIR}/deploy/gcp/Caddyfile" /etc/caddy/Caddyfile
fi
systemctl reload caddy || systemctl start caddy

echo "==> Installing systemd service"
cp "${APP_DIR}/deploy/gcp/barsha-backend.service" /etc/systemd/system/barsha-backend.service
systemctl daemon-reload
systemctl enable barsha-backend

echo "==> Setup complete."
echo "Place your .env file at ${DATA_DIR}/.env, then run:"
echo "  systemctl start barsha-backend"
