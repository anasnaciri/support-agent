# Deploying support-agent (Hetzner + Docker Compose)

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
