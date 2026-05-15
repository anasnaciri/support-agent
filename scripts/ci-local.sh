#!/bin/sh
set -eu

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

: "${DATABASE_URL:=postgres://support_agent:support_agent@localhost:5432/support_agent}"
export DATABASE_URL

echo "Running local CI checks before commit..."
echo "Using DATABASE_URL from environment or local default."

pnpm build
pnpm --filter @support-agent/db db:migrate
pnpm test
