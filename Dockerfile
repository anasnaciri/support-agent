# syntax=docker/dockerfile:1
#
# Production image for the support-agent backend (apps/api + apps/worker).
# The Next.js dashboard is NOT built here — it deploys separately to
# Cloudflare Workers (see DEPLOY.md).
#
# One shared `builder` stage compiles the whole pnpm workspace once
# (`tsc -b` → packages + apps dist); the runtime targets are thin layers
# over it so api/worker/migrate share the same base layers on disk.
#
# Build on the target host so the image matches its architecture:
#   docker compose -f docker-compose.prod.yml build

# ---- base: Node + pinned pnpm ----------------------------------------------
FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /app

# ---- builder: install all deps + compile -----------------------------------
# Keeps dev deps (typescript, drizzle-kit) — needed to build and to run
# migrations. Slimming the runtime to prod-only deps is a documented
# follow-up in DEPLOY.md; correctness first.
FROM base AS builder
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build

# ---- api: Fastify HTTP edge ------------------------------------------------
FROM builder AS api
ENV NODE_ENV=production
WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]

# ---- worker: pg-boss consumers + cron + timers -----------------------------
FROM builder AS worker
ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]

# ---- migrate: one-shot drizzle-kit migrate ---------------------------------
# Run via `docker compose run --rm migrate`. drizzle-kit is a dev dependency,
# so this target deliberately keeps the builder's full deps.
FROM builder AS migrate
WORKDIR /app
CMD ["sh", "-c", "cd packages/db && pnpm db:migrate && cd /app && pnpm --filter @support-agent/api reconcile:shopify-shipments"]
