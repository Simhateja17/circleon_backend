# GCP VM Deployment (PM2 + Caddy)

These files deploy `barsha-backend` to a Google Compute Engine VM using **PM2** as the process manager and **Caddy** as the reverse proxy / TLS terminator.

## Files

| File | Purpose |
|------|---------|
| `setup-vm-pm2.sh` | One-time VM bootstrap: Node.js 20, PM2, Caddy, app user, log directory. |
| `ecosystem.config.js` | PM2 application configuration (single instance, because the backend runs a background calling queue). |
| `Caddyfile` | Reverse proxy reference. `setup-vm-pm2.sh` generates the live `/etc/caddy/Caddyfile`. |
| `deploy.sh` | Push code from your local machine to the VM and reload PM2. |

## 1. Create the GCP VM

- **Machine type**: `e2-small` or larger (Node + calling queue background work benefits from 2+ vCPUs).
- **OS**: Ubuntu 22.04 LTS or 24.04 LTS.
- **Firewall**: Allow `TCP 80` and `TCP 443` from anywhere. Allow `TCP 22` for SSH from your IP.
- **Static external IP**: Recommended so DNS and deploy scripts stay stable.
- **Service account**: Grant only the IAM roles the backend needs (principle of least privilege).

## 2. Point DNS to the VM (recommended)

Create an A record for your API domain (e.g. `api.example.com`) pointing to the VM's external IP. This is required for automatic HTTPS via Caddy.

## 3. Bootstrap the VM

Copy this directory to the VM, then run the setup script as root:

```bash
# From your local machine
gcloud compute scp --recurse backend/deploy/gcp <VM_NAME>:~/gcp

# SSH into the VM
gcloud compute ssh <VM_NAME>

# Run setup
sudo DOMAIN=api.example.com EMAIL=you@example.com bash ~/gcp/setup-vm-pm2.sh
```

If you do not have a domain yet, omit `DOMAIN`. Caddy will serve over HTTP on port 80.

## 4. Configure environment variables

Create `/opt/barsha-backend/.env` on the VM using `.env.example` as a reference:

```bash
sudo -u barsha nano /opt/barsha-backend/.env
sudo chown barsha:barsha /opt/barsha-backend/.env
sudo chmod 600 /opt/barsha-backend/.env
```

At minimum set:

- `PORT=5001`
- `FRONTEND_URL` — your deployed frontend origin
- `APP_PUBLIC_URL` / `API_PUBLIC_URL` — your public API domain
- Supabase keys
- Apollo, Retell, Gemini keys as needed

## 5. Start the backend

As the `barsha` user on the VM:

```bash
sudo -u barsha -i
cd /opt/barsha-backend
pm2 start ecosystem.config.js
pm2 save
```

Check status:

```bash
pm2 status
pm2 logs barsha-backend
```

## 6. Deploy updates from your local machine

```bash
cd backend/deploy/gcp
VM_USER=barsha VM_IP=<VM_EXTERNAL_IP> ./deploy.sh
```

The script:

1. Rsyncs the backend to `/opt/barsha-backend` (excluding `.env`, `node_modules`, `.git`).
2. Runs `npm ci --omit=dev` on the VM.
3. Reloads the PM2 cluster with zero downtime.

## 7. Operations

| Task | Command (run as `barsha` user) |
|------|--------------------------------|
| View logs | `pm2 logs barsha-backend` |
| Restart | `pm2 restart barsha-backend` |
| Reload (zero downtime) | `pm2 reload barsha-backend` |
| Monitor | `pm2 monit` |
| Enable startup | `pm2 startup` / `pm2 save` |
| Caddy logs | `sudo journalctl -u caddy -f` |

## Security notes

- Keep `.env` out of Git; it is excluded by `.gitignore` and by `deploy.sh`.
- Restrict SSH (port 22) to your IP in the GCP firewall.
- Run the backend as the unprivileged `barsha` user, not root.
- Use Caddy's automatic HTTPS once you have a domain.
- Review the IAM roles of the VM service account.
