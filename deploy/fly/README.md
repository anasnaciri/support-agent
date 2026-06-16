# Deploy the backend (api + worker) to Fly.io

Why Fly: the IMAP/SMTP connector needs **outbound** 587/465 (SMTP submission)
and 993 (IMAP). Railway blocks outbound SMTP; Fly allows it. This deploys the
*same image* Railway used — only the host changes. The dashboard stays on
Cloudflare; only `apps/api` + `apps/worker` move here.

One Fly app, two process groups (`api`, `worker`) — see `fly.toml`.

> Run every command **from the repo root** (the Dockerfile does `COPY . .`, so
> the build context must be the whole repo).

---

## 0. One-time: install + sign in

```sh
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth signup              # or `fly auth login` if you already have an account
```

Sign up with your **domain email** (e.g. `you@nacirianas.com`), not a Gmail —
it sails through fraud review faster. Fly asks for a card at signup; that's the
"verification" you expected. No ID upload for normal accounts.

## 1. Create the app (no deploy yet)

```sh
fly apps create support-agent-backend     # pick a free, globally-unique name
```

If you change the name, update `app = "…"` in `fly.toml`.

## 2. Set secrets

Fastest path — bulk-copy from Railway, then fix the 2 host-specific ones.
`fly secrets` are encrypted env vars shared by **both** process groups.

```sh
# Pull every var from each Railway service into Fly (KEY=VALUE → encrypted env).
railway variables --service api    --kv | fly secrets import -c deploy/fly/fly.toml --stage
railway variables --service worker --kv | fly secrets import -c deploy/fly/fly.toml --stage
```

Then **override the Railway-specific values** (do NOT keep these as Railway set
them):

```sh
# DATABASE_URL: Railway's value points at postgres.railway.internal, which Fly
# can't reach. Use Railway's PUBLIC proxy URL instead — it's the
# DATABASE_PUBLIC_URL variable on your Railway Postgres service.
fly secrets set -c deploy/fly/fly.toml \
  DATABASE_URL="postgresql://…@<your-db>.proxy.rlwy.net:<port>/railway"

# Drop the Railway port refs — Fly sets the port via fly.toml (API_PORT=4000).
fly secrets unset -c deploy/fly/fly.toml PORT API_PORT DEPLOY_ROLE 2>/dev/null || true
```

> Keeping the database on Railway is the fast path (the DB was never the
> problem — only SMTP egress was). Later you can move to Fly Managed Postgres or
> Supabase and re-point `DATABASE_URL`; nothing else changes.

Reference: the full var list + which service each belongs to lives in
`deploy/railway/railway.env.example`. The ones that MUST be set for a working
backend: `DATABASE_URL`, `CREDENTIAL_ENCRYPTION_KEY`, `STATE_SIGNING_KEY`,
`APPROVAL_SIGNING_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`. The
`CREDENTIAL_ENCRYPTION_KEY` / signing keys **must be byte-identical** to what
encrypted your existing data, or stored connector credentials won't decrypt.

## 3. Deploy

```sh
fly deploy -c deploy/fly/fly.toml --dockerfile deploy/railway/Dockerfile
```

This builds the image, runs `pnpm db:migrate` once (the `release_command`), then
rolls out one `api` machine and one `worker` machine.

## 4. Make sure exactly one of each is running

```sh
fly scale count api=1 worker=1 -c deploy/fly/fly.toml
```

Keep `worker=1` — it runs the per-minute IMAP poll + sweeps; two would
double-poll. (pg-boss locks protect the queue, but one is correct.)

## 5. Verify

```sh
fly status   -c deploy/fly/fly.toml
fly logs     -c deploy/fly/fly.toml

# Health (api):
curl -fsS https://support-agent-backend.fly.dev/healthz && echo OK

# THE point of this whole move — confirm SMTP egress works from Fly:
fly ssh console -c deploy/fly/fly.toml -C \
  "node -e \"['465','587','993'].forEach(p=>{const s=require('net').connect(+p,'mail.privateemail.com');s.on('connect',()=>{console.log(p,'OK');s.end()});s.on('error',e=>console.log(p,e.code))})\""
```

You should see `465 OK / 587 OK / 993 OK` — the connection Railway refused.

## 6. Point the dashboard at the Fly api

Set the dashboard's `DASHBOARD_API_BASE_URL` to the api origin and redeploy it:

- Quick: `https://support-agent-backend.fly.dev`
- Better (stable for Shopify/Google callbacks): attach your existing hostname so
  every callback URL stays put.

```sh
fly certs add support-agent-api.nacirianas.com -c deploy/fly/fly.toml
fly certs show support-agent-api.nacirianas.com -c deploy/fly/fly.toml   # shows the DNS records to add
```

Then in Cloudflare DNS for `support-agent-api`: **remove the cloudflared tunnel
route for this host** and point it at Fly per `fly certs show` (CNAME →
`support-agent-backend.fly.dev`, set **DNS-only / grey-cloud** so Fly can issue
the cert). Once green, set these secrets to the final origin and redeploy:

```sh
fly secrets set -c deploy/fly/fly.toml \
  DASHBOARD_BASE_URL="https://app.nacirianas.com" \
  APPROVAL_BASE_URL="https://support-agent-api.nacirianas.com" \
  SHOPIFY_APP_CALLBACK_URL="https://support-agent-api.nacirianas.com/shopify/auth/callback" \
  GOOGLE_OAUTH_CALLBACK_URL="https://support-agent-api.nacirianas.com/google/auth/callback"
```

(Update the matching redirect URIs in the Shopify / Google consoles too.)

---

## Notes

- **Migrations** run via `release_command` on every deploy — idempotent, no
  manual step.
- **Re-deploy** after code changes: just re-run step 3.
- **Tune memory** per group if the worker OOMs under LLM load:
  `fly scale memory 2048 --process-group worker -c deploy/fly/fly.toml`.
- **DEPLOY_ROLE is not used on Fly** — the process command in `fly.toml` is the
  role. (It's a Railway-only switch in `start.sh`.)
