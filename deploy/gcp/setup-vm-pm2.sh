#!/usr/bin/env bash
set -euo pipefail

# GCP VM setup script for barsha-backend using PM2 + Caddy.
# Run this as root (or with sudo) on a fresh Ubuntu 22.04/24.04 LTS VM.

APP_USER="barsha"
APP_DIR="/opt/barsha-backend"
LOG_DIR="/var/log/barsha-backend"
DOMAIN="${DOMAIN:-}"        # e.g. api.example.com
EMAIL="${EMAIL:-}"          # for Caddy Let's Encrypt notifications (optional)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DEBIAN_FRONTEND=noninteractive

echo "==> Updating packages"
apt-get update
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg git rsync lsb-release

echo "==> Installing Node.js 22 LTS"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "==> Installing PM2 globally"
npm install -g pm2

echo "==> Installing Caddy"
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

echo "==> Creating app user and directories"
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "${APP_DIR}" --shell /bin/bash "${APP_USER}"
fi
mkdir -p "${APP_DIR}" "${LOG_DIR}"

# Copy deployment artifacts from this script's directory so Caddy and PM2 configs
# are available even before the first code deploy.
mkdir -p "${APP_DIR}/deploy/gcp"
rsync -avz "${SCRIPT_DIR}/" "${APP_DIR}/deploy/gcp/"

chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" "${LOG_DIR}"

echo "==> Configuring Caddy"
if [[ -n "${DOMAIN}" ]]; then
  if [[ -n "${EMAIL}" ]]; then
    cat > /etc/caddy/Caddyfile <<EOF
{
	email ${EMAIL}
}

${DOMAIN} {
	reverse_proxy localhost:5001
}
EOF
  else
    cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy localhost:5001
}
EOF
  fi
else
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
	reverse_proxy localhost:5001
}
EOF
fi
systemctl reload caddy || systemctl start caddy
systemctl enable caddy

echo "==> Configuring PM2 startup"
# Install the systemd service so PM2 resumes saved processes on boot.
pm2 startup systemd -u "${APP_USER}" --hp "${APP_DIR}" | tail -n 1 | bash

echo "==> Setup complete."
echo "Next steps:"
echo "  1. Place your .env file at ${APP_DIR}/.env (owned by ${APP_USER})"
echo "  2. Deploy the backend code (e.g. with backend/deploy/gcp/deploy.sh)"
echo "  3. From the VM as ${APP_USER}: cd ${APP_DIR} && pm2 start ecosystem.config.js && pm2 save"
