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
command. The image also defaults to the api role and runs migrations before api
startup so local `railway up` uploads remain safe when Railway does not apply
the per-service config paths. Set `DEPLOY_ROLE=worker` on the worker service.

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

The worker requires Resend in production by default. For an initial pilot that
intentionally uses dashboard approvals only, set
`PLATFORM_MAIL_ENABLED=false` on the worker. This disables approval-link,
account-deletion-confirmation, and other platform-originated emails; customer
replies still use the tenant's configured conversation connector.

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

Files: [`Dockerfile`](./Dockerfile) · [`docker-compose.prod.yml`](./docker-compose.prod.yml) · [`deploy/Caddyfile`](./deploy/Caddyfile) · [`deploy/compose/.env.example`](./deploy/compose/.env.example)

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
cp deploy/compose/.env.example deploy/compose/.env
```

Edit `deploy/compose/.env` — fill every `CHANGE_ME`. Generation commands are
in the file header. Critical invariants:

- `DATABASE_URL` host is `postgres` (the compose service); its user/password
  must match `POSTGRES_USER`/`POSTGRES_PASSWORD`.
- `APPROVAL_SIGNING_KEY` and `CREDENTIAL_ENCRYPTION_KEY` are shared by api +
  worker — set once, identical.
- `API_DOMAIN` + the `*_CALLBACK_URL` / `*_BASE_URL` values all use the real
  `api.<domain>`; `DASHBOARD_BASE_URL` uses the Workers URL.

`deploy/compose/.env` is git-ignored — keep it on the box, never commit it.

## 5. First deploy

```sh
C="docker compose -f docker-compose.prod.yml --env-file deploy/compose/.env"

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
- **Microsoft/Outlook:** create an Entra app registration ([steps below](#microsoft--outlook-azure-app-registration)) and set its redirect to
  `https://api.<domain>/microsoft/auth/callback`. Unlike Gmail there's **no
  manual subscription setup** — the Graph change-notification subscription is
  created automatically on connect and renewed by the worker cron; you only
  need `https://api.<domain>/webhooks/conversations/outlook` to be publicly
  reachable and `MICROSOFT_GRAPH_WEBHOOK_SECRET` set identically on api +
  worker.

> **Known behavior — compliance webhooks after a tenant is deleted.** In pilot
> mode each shop's webhooks are HMAC-verified with that tenant's own provisioned
> app secret. Deleting a tenant cascades away its `shopify_app_provisioning`
> row, so a *late* `shop/redact` (Shopify sends it ~48h after uninstall) can no
> longer be verified and the api returns `401`. This is safe — the tenant's data
> was already wiped at deletion, so there's nothing left to redact — but Shopify
> may log the delivery as failed. Nothing to action; don't mistake it for a
> live-tenant webhook failure.

### Microsoft / Outlook (Azure app registration)

The Outlook connector authenticates merchant mailboxes via a Microsoft Entra
(Azure AD) **app registration** — the only Azure resource needed (no App
Service, no Key Vault). Graph API usage is free; the only cost is the mailbox's
existing M365 license, which the merchant already pays.

1. **portal.azure.com → Microsoft Entra ID → App registrations → New registration.**
2. **Supported account types:** for SaaS (any merchant's Outlook/O365) pick
   *"Accounts in any organizational directory (multitenant)"* → use
   `MICROSOFT_OAUTH_TENANT=common`. For a single-org pilot pick *"this
   organizational directory only"* → use that **Directory (tenant) ID** as the
   tenant. (Personal `outlook.com` accounts need *"…and personal Microsoft
   accounts"*; Graph mail on them is flakier, so add only if required.)
3. **Redirect URI:** platform **Web** (not SPA — we use a client secret), value
   `https://api.<domain>/microsoft/auth/callback`.
4. **Certificates & secrets → New client secret →** copy the **Value** (not the
   Secret ID) → `MICROSOFT_OAUTH_CLIENT_SECRET`. Copy **Application (client) ID**
   → `MICROSOFT_OAUTH_CLIENT_ID`.
5. **API permissions → Microsoft Graph → Delegated** — add all of:
   `Mail.ReadWrite`, `Mail.Send`, **`User.Read`**, `offline_access`, `openid`,
   `email`, `profile`. ⚠️ `User.Read` is **required** — the OAuth callback reads
   the mailbox address via Graph `/me`; without it the callback 403s and the
   install fails with a 502 (`userinfo_fetch_failed`). Click **Grant admin
   consent** if you're an admin.

**One app per environment.** Don't share a single registration between the dev
Cloudflare-tunnel host and prod Railway — separate apps keep secrets isolated
and stop a churning dev redirect URL from touching prod. Each env's
`.env`/Railway vars point at its own app; use a *named* (stable) tunnel host for
dev so its redirect URI doesn't change every run.

**Env vars** (`MICROSOFT_*` on **both** api + worker; `CALLBACK_URL` is api-only):

```
MICROSOFT_OAUTH_CLIENT_ID=          # this env's app
MICROSOFT_OAUTH_CLIENT_SECRET=      # the secret Value
MICROSOFT_OAUTH_TENANT=common       # or a Directory ID for single-org
MICROSOFT_OAUTH_CALLBACK_URL=https://api.<domain>/microsoft/auth/callback   # api only
MICROSOFT_GRAPH_NOTIFICATION_URL=https://api.<domain>/webhooks/conversations/outlook
MICROSOFT_GRAPH_WEBHOOK_SECRET=     # openssl rand -hex 32
```

Three of these **must be byte-identical on api + worker**, or the connector
fails silently: `CREDENTIAL_ENCRYPTION_KEY` (api encrypts tokens, worker
decrypts them), `MICROSOFT_GRAPH_WEBHOOK_SECRET` (api webhook rejects
notifications whose `clientState` doesn't match), and the Microsoft app itself
(the worker refreshes tokens that app issued). The worker's renewal cron is
skipped unless `MICROSOFT_GRAPH_NOTIFICATION_URL` + `MICROSOFT_GRAPH_WEBHOOK_SECRET`
are both set — look for `scheduled graph-subscription-renewal cron` in its logs.

> **Before real merchants:** a multitenant app shows an "unverified" warning on
> the consent screen (and some orgs block unverified apps) until you complete
> **Publisher verification** (free, via a Microsoft Partner account). Also, each
> merchant org's admin may need to grant consent the first time, since
> `Mail.ReadWrite`/`Mail.Send` often aren't user-consentable by org policy.

## 7. Updating

```sh
C="docker compose -f docker-compose.prod.yml --env-file deploy/compose/.env"
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
C="docker compose -f docker-compose.prod.yml --env-file deploy/compose/.env"
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

## Front-ends on Cloudflare Workers (OpenNext)

Both Next.js front-ends are **pure api clients** (Path B): every read/write goes
through apps/api over HTTPS — no Postgres/Drizzle or pg-boss on the edge — so
they deploy to Cloudflare Workers via
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare). Each app carries
its own `wrangler.jsonc` + `open-next.config.ts` and these scripts:

```
pnpm --filter @support-agent/<app> cf:build     # opennextjs-cloudflare build → .open-next/
pnpm --filter @support-agent/<app> cf:preview   # build + run locally in workerd
pnpm --filter @support-agent/<app> cf:deploy    # build + wrangler deploy   (needs `wrangler login`)
```

Runtime config is **not** committed. Copy each app's `.dev.vars.example` →
`.dev.vars` for local preview, and in production set each secret with
`wrangler secret put <NAME>` (or the Cloudflare dashboard). `NEXT_PUBLIC_*` vars
are inlined at **build** time, so set them in the shell for `cf:build`/`cf:deploy`.

### `apps/admin` — operator console ✅ deployable

No middleware, so `cf:build` succeeds today. Secrets: `ADMIN_API_BASE_URL`,
`ADMIN_API_TOKEN` (must equal the api's), `ADMIN_DASHBOARD_PASSWORD`,
`ADMIN_SESSION_SECRET`. Run `cf:deploy` with your account.

> **⚠️ Network-gate this app — required, not optional.** The operator console
> authenticates with a **single shared password** and has **no login
> rate-limiting or lockout**, yet it holds the `ADMIN_API_TOKEN` and can
> provision Shopify credentials, revoke connectors, and **delete any tenant**.
> A public login is brute-forceable. Put it behind **Cloudflare Access** (SSO /
> email allowlist) or an IP allowlist / non-public hostname **before** exposing
> it, and set a long, random `ADMIN_DASHBOARD_PASSWORD` (never the dev value).
> Per-operator identity is still on the roadmap (audit rows record actor
> `admin`, not an individual) — Cloudflare Access in front gives you the
> per-person identity + MFA the app itself doesn't yet enforce.

### `apps/dashboard` — merchant dashboard ✅ deployable (middleware-less AuthKit)

`cf:build` is green. The historical blocker was WorkOS **AuthKit**: its
`authkitProxy()` ran as Next middleware, but **Next 16's proxy is Node-only**
(it rejects `runtime: "edge"`) and `@opennextjs/cloudflare` (≤ 1.19.11, the
latest) refuses Node middleware — so OpenNext aborted with *"Node.js middleware
is not currently supported."*

Resolved by removing the proxy and reading the WorkOS session **directly from
its cookie** (`lib/session.ts` `getSession()`): it unseals the `wos-session`
cookie with `iron-session` (the same library + `WORKOS_COOKIE_PASSWORD` AuthKit
seals it with, so unsealing authenticates it) and decodes the access-token
claims via AuthKit's public `getTokenClaims`. OpenNext sees **no middleware** →
the build proceeds. Page-level auth is unchanged: every tenant page calls
`getDashboardContext()`, which redirects logged-out users to `/sign-up`. The
cookie-writing flows (`/sign-in`, `/callback`, sign-out) are untouched.

**Trade-off (accepted):** there's no token refresh on the request path (a proxy
did that). `getSession()` honors the access token's `exp` and treats an expired
token as logged-out, so the user is redirected to re-auth once it lapses —
WorkOS still holds the SSO session, so it's a silent round-trip. Tune the access
token lifetime in the WorkOS dashboard if the re-auth cadence is too tight.

Secrets (set with `wrangler secret put`, except `NEXT_PUBLIC_*` which are build
-time): `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` (≥32
chars), `NEXT_PUBLIC_WORKOS_REDIRECT_URI` (= `https://app.<domain>/callback`),
`DASHBOARD_API_BASE_URL` (the api origin), and `DASHBOARD_API_TOKEN` (must equal
the api's). Map `app.<domain>` to the Worker, then run `cf:deploy`. The two
api↔dashboard link points: `DASHBOARD_BASE_URL` (api → dashboard redirects) and
the api's public origin (dashboard → api fetches).

## Note: image size

The runtime images keep dev dependencies (~1.5 GB) for build + migration
simplicity. To slim them later, add a prod-pruned runtime stage
(`pnpm deploy --prod` or a `--prod` reinstall) and point `target: api/worker`
at it; keep `migrate` on the full builder (drizzle-kit is a dev dep).
