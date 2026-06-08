#!/bin/sh
set -eu

case "${DEPLOY_ROLE:-api}" in
  api)
    cd /app/packages/db
    pnpm db:migrate
    cd /app
    exec node apps/api/dist/server.js
    ;;
  worker)
    exec node apps/worker/dist/index.js
    ;;
  *)
    echo "Unsupported DEPLOY_ROLE: ${DEPLOY_ROLE}" >&2
    exit 64
    ;;
esac
