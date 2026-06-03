# ShipKit Deployment

Both apps run as Docker containers on a single GCP Compute Engine VM, behind a
Caddy reverse proxy. CI/CD (GitHub Actions) builds images, pushes them to GHCR,
and redeploys over SSH.

```
            ┌──────────────── GCP VM (shipkit-vm) ─────────────────┐
  Internet  │  Caddy :80/:443                                       │
  ────────▶ │    ├── /api/*  → backend  container  (NestJS  :3000)  │
            │    └── /*      → frontend container  (SSR     :3000)  │
            └──────────────────────────────────────────────────────┘
   images: ghcr.io/murarishettybhanu/coach-connect-portal[-backend]
```

The frontend calls the backend at `/api` (same origin) — Caddy routes it — so no
backend host is baked into the client bundle.

## 1. Provision the VM (one-time, billable)

```bash
# from the backend repo root
PROJECT=project-ed393033-4d39-4f83-820 ZONE=asia-south1-c ./deploy/provision.sh
```

Then copy the infra files up and create the deploy SSH key:

```bash
ZONE=asia-south1-c
gcloud compute scp deploy/docker-compose.yml deploy/Caddyfile shipkit-vm:/tmp/ --zone=$ZONE
gcloud compute ssh shipkit-vm --zone=$ZONE --command "sudo mv /tmp/docker-compose.yml /tmp/Caddyfile /opt/shipkit/"

# SSH key for GitHub Actions
ssh-keygen -t ed25519 -f shipkit_deploy -N "" -C "github-actions"
gcloud compute ssh shipkit-vm --zone=$ZONE --command \
  "echo '$(cat shipkit_deploy.pub)' >> ~/.ssh/authorized_keys"
# SSH_USER = your gcloud username on the VM (whoami over ssh); SSH_PRIVATE_KEY = contents of shipkit_deploy
```

## 2. GitHub secrets

Add these in **each repo** → Settings → Secrets and variables → Actions.

### Backend repo (`coach-connect-portal-backend`)

| Secret            | Required | Example / notes                                            |
| ----------------- | -------- | ---------------------------------------------------------- |
| `SSH_HOST`        | ✅       | VM external IP (from provision output)                     |
| `SSH_USER`        | ✅       | Linux user on the VM (e.g. your gcloud username)           |
| `SSH_PRIVATE_KEY` | ✅       | Contents of `shipkit_deploy` (the private key)             |
| `MONGODB_URI`     | ✅       | `mongodb+srv://…` (your Atlas connection string)           |
| `JWT_SECRET`      | ✅       | A long random string                                       |
| `SITE_ADDRESS`    | ⬜       | Domain for HTTPS (e.g. `shipkit.example.com`); omit for IP |

### Frontend repo (`coach-connect-portal`)

| Secret            | Required | Example / notes                                  |
| ----------------- | -------- | ------------------------------------------------ |
| `SSH_HOST`        | ✅       | Same VM external IP                              |
| `SSH_USER`        | ✅       | Same VM user                                     |
| `SSH_PRIVATE_KEY` | ✅       | Same private key                                 |
| `VITE_API_URL`    | ⬜       | Defaults to `/api` (same-origin). Override only if the API is on a different origin |

`GITHUB_TOKEN` is provided automatically — no need to add it. It is used to push
to and pull from GHCR.

> The first backend deploy writes `/opt/shipkit/.env` from `MONGODB_URI` /
> `JWT_SECRET` / `SITE_ADDRESS`, so deploy the **backend first**.

## 3. Deploy

Push to `main` in either repo (or run the workflow manually). Each push:
1. builds the Docker image,
2. pushes `ghcr.io/<repo>:latest`,
3. SSHes to the VM, `docker compose pull` + `up -d`.

Visit `http://<VM_IP>/` (or your domain). API is at `http://<VM_IP>/api`.

## Notes
- GHCR packages are private by default; the workflows `docker login` on the VM with
  `GITHUB_TOKEN` each deploy, so no extra registry secret is needed.
- For HTTPS: point a domain's A record at the VM IP, set the `SITE_ADDRESS` secret to
  that domain, and redeploy — Caddy fetches a Let's Encrypt cert automatically.
- The MongoDB is **Atlas** (external), so the VM holds no database; back it up via Atlas.
