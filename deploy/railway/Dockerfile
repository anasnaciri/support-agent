# syntax=docker/dockerfile:1
#
# Railway image for the support-agent backend (apps/api + apps/worker).
#
# Railway builds ONE image and runs each role from it as a per-service Start
# Command (api / worker), with migrations as the api service's Pre-Deploy
# Command — see DEPLOY.md "Railway (primary)". Unlike the root ./Dockerfile
# (which exposes explicit api/worker/migrate targets for docker-compose),
# Railway's Dockerfile builder has no stage selector, so this image just stops
# at the full build and lets the start command pick the role.
#
# Dev deps (typescript, drizzle-kit) are kept on purpose: drizzle-kit runs the
# migrations in the api Pre-Deploy Command. Slimming is the same follow-up
# noted for the root Dockerfile.

FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
ENV NODE_ENV=production
# Default role is the api; the worker service overrides this in worker.json.
# WORKDIR stays /app so the per-service start commands use workspace-relative
# paths (node apps/api/dist/server.js, node apps/worker/dist/index.js).
CMD ["node", "apps/api/dist/server.js"]
