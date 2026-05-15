# Cloudflare Tunnel — `support-agent-api`

Exposes the local `apps/api` Node server as
`https://support-agent-api.nacirianas.com` so Shopify can call our
managed-install OAuth callback (and, later, webhooks) without ngrok.

## What was provisioned (one-time)

```sh
cloudflared tunnel create support-agent-api
# → tunnel id: 52265c89-b174-47ea-ba31-1af7515ca2ea
# → credentials JSON written to ~/.cloudflared/52265c89-...json

cloudflared tunnel route dns support-agent-api support-agent-api.nacirianas.com
# → CNAME support-agent-api.nacirianas.com → 52265c89-...cfargotunnel.com
```

Both of these talk to Cloudflare's control plane and create resources
attached to the operator's CF account. Don't re-run them.

### Why a flat (single-level) subdomain

Cloudflare's free Universal SSL only covers the root + one level of
subdomain (`*.nacirianas.com`). A two-level name like
`api.support-agent.nacirianas.com` would be served by Cloudflare's edge
without a matching cert and abort the TLS handshake — confirmed live
when we first tried it. A flat name like `support-agent-api.nacirianas.com`
is one level deep and Just Works on the free plan.

A leftover orphan CNAME `api.support-agent.nacirianas.com → ...cfargotunnel.com`
exists in the zone from the initial provisioning attempt; it's not
referenced by any ingress rule and is safe to leave or delete via the
Cloudflare dashboard.

## Running it

Terminal A — the API server:

```sh
pnpm --filter @support-agent/api start:dev
# listens on http://localhost:4000
```

Terminal B — the tunnel:

```sh
cloudflared tunnel --config cloudflared/config.yml run support-agent-api
```

Health-check:

```sh
curl https://support-agent-api.nacirianas.com/healthz
# → ok
```

## Operator notes

- The credentials JSON at `~/.cloudflared/<tunnel-id>.json` is a secret
  and is **not** in the repo. To re-mint after losing it, delete the
  tunnel (`cloudflared tunnel delete support-agent-api`) and re-run the
  provisioning commands above.
- `config.yml` references the credentials file by absolute path; if you
  move the credentials, update that path.
- Shopify Partner Dashboard "Allowed redirection URLs" must contain
  `https://support-agent-api.nacirianas.com/shopify/auth/callback`
  exactly — no trailing slash, no other paths.

## Tearing it down

```sh
cloudflared tunnel delete support-agent-api
# also removes the CNAME via the Cloudflare API
```
