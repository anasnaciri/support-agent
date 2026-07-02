# Deploying the Vite SPA dashboard (Cloudflare Workers static assets)

The SPA is a 100% client-side app — it holds no secrets and runs no server code.
It ships as a **Workers static-assets** deployment (`wrangler.jsonc`, no `main`
script): Cloudflare serves the Vite `dist/` output and, via
`not_found_handling: "single-page-application"`, returns `index.html` for any
unmatched path so the client router handles deep links.

It deploys under its **own** Worker name (`support-agent-dashboard-v2`), so the
existing Next `apps/dashboard` Worker stays live during the migration. Its origin
is either the account `workers.dev` URL (`<name>.<account>.workers.dev`) or a
custom domain (§4).

## 1. Build-time env (baked into the bundle)

Vite inlines `VITE_*` at **build** time — there is no runtime env for a static
site. The deploy build must run with the production values in its environment
(see `.env.example` for the full list):

- `VITE_API_BASE_URL` — public origin of `apps/api` (e.g. `https://api.example.com`)
- `VITE_WORKOS_CLIENT_ID` — WorkOS client id (public)
- `VITE_WORKOS_REDIRECT_URI` — `apps/api`'s callback, e.g.
  `https://api.example.com/dashboard/auth/callback`
- `VITE_SPA_ORIGIN` — this SPA's public origin (e.g. `https://app-spa.example.com`)

## 2. Deploy

```sh
VITE_API_BASE_URL=https://api.example.com \
VITE_WORKOS_CLIENT_ID=client_… \
VITE_WORKOS_REDIRECT_URI=https://api.example.com/dashboard/auth/callback \
VITE_SPA_ORIGIN=https://app-spa.example.com \
pnpm --filter @support-agent/dashboard-spa cf:deploy
```

`cf:deploy` runs `pnpm build` (tsc + vite) then `wrangler deploy` (uploads
`dist/`). `cf:preview` builds + serves it locally via `wrangler dev`. First-time
setup needs a Cloudflare login (`wrangler login`) and the account selected.

## 3. Wire the surrounding services (one-time, on `apps/api` + WorkOS)

The SPA calls `apps/api` cross-origin **with credentials** (the httpOnly session
cookie the api mints — Option B / the BFF). So, on the API side:

- **WorkOS** — register `VITE_WORKOS_REDIRECT_URI`
  (`https://api.example.com/dashboard/auth/callback`) as an allowed redirect URI.
- **`apps/api` env** — set `DASHBOARD_SPA_ORIGIN` to this SPA's origin
  (`VITE_SPA_ORIGIN`) and `DASHBOARD_BFF_REDIRECT_URI` to the callback above, and
  ensure `API_SESSION_PASSWORD` (≥32 chars) is set. The api's `/dashboard/*` CORS
  allowlist + CSRF origin check key off `DASHBOARD_SPA_ORIGIN`; without it the
  browser's credentialed requests are blocked.

## 4. Origin: workers.dev vs custom domain

- **workers.dev (default):** with `workers_dev: true`, the Worker is served at
  `https://<name>.<account-subdomain>.workers.dev` — the URL is known from the
  Worker name + your account subdomain (no first-deploy discovery needed). NOTE:
  this is a DIFFERENT site from the api (`*.fly.dev`), so the session cookie is
  cross-site — it relies on `SameSite=None; Secure` (the api sets this on https)
  and the browser not blocking third-party cookies. Fine for testing; for prod,
  prefer a subdomain sharing the api's parent domain.
- **Custom domain:** map a hostname (e.g. `app-spa.example.com`) to the
  `support-agent-dashboard-v2`
  Worker (Cloudflare dashboard → Workers → Custom Domains / Routes), then set
`VITE_SPA_ORIGIN` to it and rebuild/redeploy.
