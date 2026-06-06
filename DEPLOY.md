# Deploying support-agent

Two supported deploy targets, both built from this one repo (no source fork —
deploy config is per-variant under `deploy/`):

- **[Railway](#railway-primary) — primary.** Managed Postgres + two services
  (api, worker) from the Dockerfile; TLS + domains managed. Fastest to stand
  up; chosen for the pilot.
- **[Hetzner + Docker Compose](#hetzner--docker-compose-alternative) —
  alternative.** Self-hosted on a VPS (postgres + api + worker + Caddy).
  Cheaper at steady state; EU-native. Kept fully documented below.

In both, the Next.js **dashboard** deploys separately to Cloudflare Workers as
a pure api client (Path B — see [Dashboard](#dashboard-cloudflare-workers)).

---

## Railway (primary)

```
┌─ Railway project ─────────────────────────────┐
│  Postgres (managed)                            │      Cloudflare Workers
│     ▲          ▲                               │      ┌──────────────┐
│     │          │                               │      │  dashboard   │
│  api ◀──────▶ worker     api → api.<domain> ───┼─────▶│ (Path B)     │
│  (public)    (no port)   (TLS by Railway)      │      └──────────────┘
└────────────────────────────────────────────────┘
```

The api and worker run from **one image** (`deploy/railway/Dockerfile`); each
service picks its role via its Start Command. Config is version-controlled:
[`deploy/railway/api.json`](./deploy/railway/api.json),
[`deploy/railway/worker.json`](./deploy/railway/worker.json),
[`deploy/railway/railway.env.example`](./deploy/railway/railway.env.example).

### 1. Project + Postgres

```sh
npm i -g @railway/cli      # or: brew install railway
railway login              # interactive — run this yourself (e.g. `! railway login`)
railway init               # create a project (or `railway link` an existing one)
railway add --database postgres
```

### 2. Create the two services

Create **two** services in the project, both deploying from this repo:

| Service | Config-as-code path (Settings → Config) | Public domain? |
| --- | --- | --- |
| `api` | `deploy/railway/api.json` | Yes — generate one, then add `api.<domain>` |
| `worker` | `deploy/railway/worker.json` | No (background service) |

Both build `deploy/railway/Dockerfile`. The `api.json` sets the start command,
a **Pre-Deploy Command** that runs `pnpm db:migrate` (drizzle-kit ships in the
image), and a `/healthz` healthcheck. `worker.json` just sets the worker start
command. If your Railway version ignores `preDeployCommand` from config, set it
in the api service's Settings → Deploy → Pre-Deploy Command instead.

### 3. Variables

Copy from [`deploy/railway/railway.env.example`](./deploy/railway/railway.env.example).
Set the `[shared]` vars as **project shared variables** (referenced by both
services) and the `[api]` / `[worker]` vars on their service. Two Railway
specifics:

- `DATABASE_URL=${{ Postgres.DATABASE_URL }}` — references the managed Postgres
  over the private network (no host to manage).
- `API_PORT=${{ PORT }}` on the **api** — Fastify reads `API_PORT`; Railway
  injects `PORT`. The worker has no port. You do **not** need `API_DOMAIN`,
  `ACME_EMAIL`, or any `POSTGRES_*` (managed + TLS handled by Railway).

`CREDENTIAL_ENCRYPTION_KEY` and `APPROVAL_SIGNING_KEY` must be **identical** on
api + worker — set them as shared variables once.

### 4. Deploy

```sh
railway up                 # build + deploy the current service
railway logs               # tail; check the api Pre-Deploy ran migrations
```

Generate the api's public domain, then `curl https://<api>.up.railway.app/healthz`
→ `{"ok":true}`. Add the custom domain `api.<domain>` (Railway shows the CNAME
to set at your DNS) and update `APPROVAL_BASE_URL` / `SHOPIFY_APP_CALLBACK_URL`
/ `GOOGLE_OAUTH_CALLBACK_URL` to it.

### 5. External provider config

Same as Hetzner [§6 below](#6-external-provider-config) — point every Shopify /
Google callback + webhook URL at `https://api.<domain>` (the Railway custom
domain). For the per-tenant pilot apps, the redirect + webhook URLs are
identical across apps (see `todo.md` / the provisioning runbook); only the
keys + store domain differ.

### Region + backups (GDPR / PCD)

- Pick an **EU region** for the project if you have EU customers (data
  residency for the PCD attestation in `docs/shopify-pcd.md`).
- Railway Postgres has backups, but confirm retention meets the PCD "encrypted
  backups" commitment; otherwise point `DATABASE_URL` at a dedicated managed
  Postgres and keep only the app services on Railway. (pg-boss needs real
  `LISTEN/NOTIFY` — avoid serverless Postgres poolers like Neon/Supabase
  transaction mode for the worker's direct connection.)

### Cost (pilot scale)

5 tenants × ~50 orders/day is a near-flat floor — two always-on Node services +
a small Postgres ≈ **~$20–35/mo** (Pro plan's $20 usage credit covers most of
it). LLM inference is BYOK (tenant-billed), so it is **not** on this bill; the
Railway cost barely moves with order volume at this scale.

---

## Hetzner + Docker Compose (alternative)

Production topology for the pilot:

```
┌─ Hetzner Cloud VPS (Docker Compose) ──────────────┐
│  postgres ── api ── worker        caddy (TLS)      │      Cloudflare Workers
│     │         │       │             │              │      ┌──────────────┐
│     └─────────┴───────┘             └─ :443 ───────┼─────▶│  dashboard   │
│        internal network          api.<domain>      │      │ (Path B,     │
└────────────────────────────────────────────────────┘      │  pending)    │
                                                             └──────────────┘
```

- **On the box:** Postgres (internal only), the Fastify **api** (OAuth
  callbacks, Shopify/Gmail webhooks, approval links), and the **worker**
  (pg-boss consumers, cron, follow-up timers). Caddy terminates TLS for the
  api.
- **Not on the box:** the Next.js **dashboard** deploys separately to
  Cloudflare Workers and talks to the api over HTTPS (see
  [Dashboard](#dashboard-cloudflare-workers)).

Files: [`Dockerfile`](./Dockerfile) · [`docker-compose.prod.yml`](./docker-compose.prod.yml) · [`deploy/Caddyfile`](./deploy/Caddyfile) · [`.env.prod.example`](./.env.prod.example)

---

## 1. Provision the box

[Hetzner Cloud](https://www.hetzner.com/cloud) → new server:

- **Type:** `CAX21` (ARM, 4 vCPU / 8 GB, ~€7–9/mo) or `CPX22` (x86, 3 vCPU /
  4 GB). 8 GB is recommended so building the images on the box has headroom.
- **Image:** Ubuntu 24.04.
- **Location:** an EU region (Falkenstein / Nuremberg / Helsinki) for GDPR
  data residency.
- **SSH key:** add yours; disable password auth.
- **Firewall** (Hetzner Cloud Firewall): allow `22` from your IP only, and
  `80` + `443` from anywhere. (If you front the api with a cloudflared tunnel
  instead of Caddy, you can drop `80`/`443` too — see
  [HTTPS alternative](#https-alternative-cloudflare-tunnel).)

## 2. Base setup (on the box)

```sh
# Docker engine + compose plugin
curl -fsSL https://get.docker.com | sh

# Basic hardening
apt-get update && apt-get install -y fail2ban unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# Run the app as a non-root user in the docker group
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
```

Continue as `deploy`.

## 3. DNS

Point the api hostname straight at the box (DNS-only, **not** proxied, so
Caddy's Let's Encrypt HTTP-01 challenge works):

| Record | Type | Value | Proxy |
| --- | --- | --- | --- |
| `api.<domain>` | A | `<box IPv4>` | DNS only (grey cloud) |

The dashboard hostname (`app.<domain>`) is managed by Cloudflare Workers, not
this box.

## 4. Configure

```sh
git clone <repo-url> support-agent && cd support-agent
cp .env.prod.example .env.prod
```

Edit `.env.prod` — fill every `CHANGE_ME`. Generation commands are in the file
header. Critical invariants:

- `DATABASE_URL` host is `postgres` (the compose service); its user/password
  must match `POSTGRES_USER`/`POSTGRES_PASSWORD`.
- `APPROVAL_SIGNING_KEY` and `CREDENTIAL_ENCRYPTION_KEY` are shared by api +
  worker — set once, identical.
- `API_DOMAIN` + the `*_CALLBACK_URL` / `*_BASE_URL` values all use the real
  `api.<domain>`; `DASHBOARD_BASE_URL` uses the Workers URL.

`.env.prod` is git-ignored — keep it on the box, never commit it.

## 5. First deploy

```sh
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"

$C build                 # builds images on the box (matches its arch)
$C run --rm migrate      # applies drizzle migrations against fresh Postgres
$C up -d                 # starts postgres + api + worker + caddy

$C ps
curl -fsS https://api.<domain>/healthz   # -> {"ok":true} once Caddy has a cert
```

## 6. External provider config

The box is now reachable; finish the provider side (also tracked in
`todo.md` → "First real merchant connector launch checklist"):

- **Shopify:** set the custom app's redirect to
  `https://api.<domain>/shopify/auth/callback`, put the real `client_id` +
  host in `shopify.app.toml`, then `shopify app config link && shopify app
  deploy`.
- **Google/Gmail:** set the OAuth redirect to
  `https://api.<domain>/google/auth/callback`; create the Pub/Sub topic +
  push subscription to
  `https://api.<domain>/webhooks/conversations/gmail/<tenantId>?token=<GMAIL_PUSH_TOKEN>`.

## 7. Updating

```sh
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
git pull
$C build
$C run --rm migrate      # no-op if no new migrations
$C up -d                 # recreates only changed services
```

## 8. Backups

Two layers:

1. **Whole-box:** enable Hetzner automated backups (+20% on the server price)
   for snapshot/restore.
2. **App-level (nightly `pg_dump` → R2):** reuses the R2 bucket you already
   configure for image attachments. Add to `deploy`'s crontab:

   ```sh
   # 03:15 daily — dump, gzip, push to R2 via rclone (configure `rclone` once)
   15 3 * * * docker exec support-agent-postgres-1 pg_dump -U support_agent support_agent | gzip | rclone rcat r2:my-bucket/backups/pg-$(date +\%F).sql.gz
   ```

## 9. Ops

```sh
C="docker compose -f docker-compose.prod.yml --env-file .env.prod"
$C logs -f api worker        # tail
$C restart api               # restart one service
$C exec postgres psql -U support_agent support_agent   # DB shell
```

## HTTPS alternative: Cloudflare Tunnel

To reuse the existing tunnel (`cloudflared/`) instead of Caddy and expose **no**
inbound ports: remove the `caddy` service from `docker-compose.prod.yml`, add a
`cloudflared` service (image `cloudflare/cloudflared`, `command: tunnel run`,
mount the tunnel credentials) with ingress `api.<domain> → http://api:4000`,
and set the Hetzner firewall to deny `80`/`443`. TLS is then terminated at
Cloudflare's edge.

## Dashboard (Cloudflare Workers)

The dashboard is **not** in this compose stack. Under **Path B**, it becomes a
pure api client: all reads go through the api over HTTPS (no Postgres/Drizzle
or pg-boss on the edge), deployed to Cloudflare Workers via
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare). The two link
points are `DASHBOARD_BASE_URL` (api → dashboard redirects) and the api's
public origin (dashboard → api fetches).

> **Status:** the Path B refactor (api read endpoints + dashboard rewired to
> fetch + OpenNext/wrangler config) is a separate workstream and is **not yet
> implemented**. Until it lands, run the dashboard the old way (Node host /
> `next start`) against the same `DATABASE_URL`, or keep it offline for a
> headless pilot driven by approval-link emails.

## Note: image size

The runtime images keep dev dependencies (~1.5 GB) for build + migration
simplicity. To slim them later, add a prod-pruned runtime stage
(`pnpm deploy --prod` or a `--prod` reinstall) and point `target: api/worker`
at it; keep `migrate` on the full builder (drizzle-kit is a dev dep).
