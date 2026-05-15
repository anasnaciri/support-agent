#!/bin/sh
set -eu

required=0
if [ "${1:-}" = "--required" ]; then
  required=1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Skipping Git hook setup because this is not a Git checkout."
  exit 0
fi

if git config core.hooksPath .githooks; then
  echo "Git hooks installed from .githooks"
  exit 0
fi

echo "Unable to install Git hooks. Run pnpm hooks:install from a writable Git checkout."

if [ "$required" -eq 1 ]; then
  exit 1
fi

exit 0
