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

# 同一LAN上の別端末（スマホ等）からsslip.io経由でアクセスできるよう、
# Windows側のポートフォワーディングをベストエフォートで設定する（失敗してもdevサーバー起動は続行する）。
#
# ワンクリック起動（scripts/start-local-session.sh）から始まったセッションでは
# ISSUE_DECK_SKIP_LAN_SETUP=1 が環境変数として届く。この経路（wt.exeで開いたタブ）では
# UACを承認しても待ちから戻らず、devサーバーが起動しないまま止まるため行わない（#1094）。
if [ "${ISSUE_DECK_SKIP_LAN_SETUP:-0}" != "0" ]; then
  echo "LANアクセス設定はスキップします（LAN内の別端末から見る場合は scripts/setup-lan-access.sh ${PORT} を実行してください）。" >&2
else
  bash "$(dirname "${BASH_SOURCE[0]}")/setup-lan-access.sh" "${PORT}" || echo "警告: LANアクセス設定に失敗しました。localhostでの確認は引き続き可能です。" >&2
fi

SMEE_PID=""
if [ -n "${GITHUB_WEBHOOK_PROXY_URL:-}" ]; then
  pnpm exec smee --url "${GITHUB_WEBHOOK_PROXY_URL}" --target "http://127.0.0.1:${PORT}/api/webhooks/github" &
  SMEE_PID=$!
  trap 'kill "${SMEE_PID}" 2>/dev/null || true' EXIT
else
  echo "GITHUB_WEBHOOK_PROXY_URL が未設定のため、smee client は起動しません。" >&2
fi

next dev -p "${PORT}"
