#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# next devは.env.localを自動読込するが、このスクリプト自身（bash）は読み込まないため明示的に読む。
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

PORT="${PORT:-3000}"

SMEE_PID=""
if [ -n "${GITHUB_WEBHOOK_PROXY_URL:-}" ]; then
  pnpm exec smee --url "${GITHUB_WEBHOOK_PROXY_URL}" --target "http://127.0.0.1:${PORT}/api/webhooks/github" &
  SMEE_PID=$!
  trap 'kill "${SMEE_PID}" 2>/dev/null || true' EXIT
else
  echo "GITHUB_WEBHOOK_PROXY_URL が未設定のため、smee client は起動しません。" >&2
fi

next dev -p "${PORT}"
