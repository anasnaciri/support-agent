# syntax=docker/dockerfile:1
#
# Railway image for the support-agent backend (apps/api + apps/worker).
#
# Railway builds ONE image and selects the runtime role in start.sh. This also
# supports CLI uploads, where Railway does not apply the repo's per-service
# config-as-code paths. Unlike the root ./Dockerfile (which exposes explicit
# api/worker/migrate targets for docker-compose), Railway's Dockerfile builder
# has no stage selector.
#
# Dev deps (typescript, drizzle-kit) are kept on purpose: drizzle-kit runs the
# api migrations at startup and in config-as-code Pre-Deploy. Slimming is the
# same follow-up noted for the root Dockerfile.

FROM node:24-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
ENV NODE_ENV=production
# DEPLOY_ROLE defaults to api. Set DEPLOY_ROLE=worker on the worker service.
CMD ["sh", "deploy/railway/start.sh"]
