#!/usr/bin/env bash
# Issue #258: 無人実行(CI)で開発サーバーを起動し、Playwrightでデスクトップ・モバイル
# 両方のスクリーンショットを撮影したうえで、scripts/post-issue-screenshot.sh（#255）を
# 呼び出してscreenshotsブランチへ配置し、Issueコメント埋め込み用のraw URLを標準出力に
# 1行1URLで出力する（1行目がデスクトップ、2行目がモバイル）。
#
# 使い方:
#   scripts/capture-issue-screenshots.sh <Issue番号> [撮影対象パス]
#
# 前提:
#   - pnpm install済み、Playwrightのブラウザ本体(chromium)がインストール済みであること
#     (`pnpm exec playwright install --with-deps chromium`)
#   - DBマイグレーション・ダミーデータのシード（scripts/ci-seed-user.mjs含む）が
#     完了していること(#256, #257)
#   - `gh`コマンドで認証済み、`screenshots`ブランチへpushできる権限があること
#     (scripts/post-issue-screenshot.shと同じ前提)
#
# 撮影対象パスの既定値は/dashboard。"/"はCIバイパスCookie使用時、
# src/lib/supabase/middleware.tsの挙動によりログイン画面へ遷移してしまうため
# ダッシュボードを直接指定している。

set -euo pipefail

ISSUE_NUMBER="${1:?Issue番号を指定してください}"
TARGET_PATH="${2:-/dashboard}"

if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: issue番号は数字で指定してください: $ISSUE_NUMBER" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3100}"
BASE_URL="http://127.0.0.1:${PORT}"
export DATABASE_URL="${DATABASE_URL:-mysql://placeholder:placeholder@127.0.0.1:3306/app_issue_deck}"
export CI_LOGIN_BYPASS_SECRET="${CI_LOGIN_BYPASS_SECRET:-ci-screenshot-bypass-secret}"

OUT_DIR="$(mktemp -d)"
LOG_FILE="$(mktemp)"

cleanup() {
  if [[ -n "${DEV_PID:-}" ]]; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

cd "$ROOT"
pnpm exec next dev -p "$PORT" >"$LOG_FILE" 2>&1 &
DEV_PID=$!

echo "開発サーバーの起動を待機します（${BASE_URL}${TARGET_PATH}）..." >&2
READY=false
for _ in $(seq 1 60); do
  if curl --silent --fail --output /dev/null "${BASE_URL}${TARGET_PATH}"; then
    READY=true
    break
  fi
  sleep 1
done

if [[ "$READY" != "true" ]]; then
  echo "Error: 開発サーバーが起動しませんでした。ログ:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

node "$ROOT/scripts/capture-screenshots.mjs" "${BASE_URL}${TARGET_PATH}" "$OUT_DIR"

bash "$ROOT/scripts/post-issue-screenshot.sh" "$ISSUE_NUMBER" "$OUT_DIR/desktop.png" "$OUT_DIR/mobile.png"
