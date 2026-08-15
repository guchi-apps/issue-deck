#!/usr/bin/env bash
# ローカル開発用のダミーデータを開発DBへ投入する（#1473）。
#
# 使い方:
#   pnpm db:seed:dev
#
# 背景。開発サーバー（`pnpm dev`）を起こしても画面に何も出ないのは「開発環境ではデータを
# 取れない」からではなく、`.env.local`のGitHub App設定がCI用のダミー値のままで
# インストール導線が成立せず、`GithubInstallation`が1件も作れないため。実データを流したい
# 場合は開発用GitHub Appの設定が要るが、見た目・操作の確認だけならCIが使っている
# ダミーデータ（scripts/ci-seed-user.mjs・scripts/seed-ci-db.mjs）で足りる。
# このスクリプトは、その2つをローカルから1コマンドで叩けるようにするだけの薄いラッパー。
#
# ダミーで埋まらない範囲（PR一覧・サブIssue・再同期・Webhook・Projectsの進捗同期）は
# GitHub APIと実インストールが要る。docs/multi-agent/local-quick-start.md を参照。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE がありません。先に pnpm env:init を実行してください。" >&2
  exit 1
fi

# next devは.env.localを自動で読むが、このスクリプト自身（bash）は読まないため明示的に読む
# （scripts/dev.sh と同じ形）。
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

if [ "${NODE_ENV:-}" = "production" ]; then
  echo "Error: NODE_ENV=production では実行できません（ダミーデータの投入は開発環境専用です）。" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "Error: $ENV_FILE に DATABASE_URL がありません。" >&2
  exit 1
fi

# **本番DBへ流さないための最後の砦。** このスクリプトは既存行を書き換える処理
# （SEED_PROFILE=dev の後処理）を含むため、接続先がローカルであることを実行前に確かめる。
DB_HOST="$(python3 -c "
import sys, urllib.parse
print(urllib.parse.urlparse(sys.argv[1]).hostname or '')
" "$DATABASE_URL")"

case "$DB_HOST" in
  localhost | 127.0.0.1 | ::1) ;;
  *)
    echo "Error: DATABASE_URL の接続先がローカルではありません（host=${DB_HOST:-不明}）。ダミーデータの投入を中止します。" >&2
    exit 1
    ;;
esac

echo "開発用ダミーデータを投入します（host=${DB_HOST}）。"

node "$ROOT/scripts/ci-seed-user.mjs"
SEED_PROFILE=dev node "$ROOT/scripts/seed-ci-db.mjs"

# 投入したダミーデータはCIバイパス用ユーザー（ci-screenshot-bot）に紐づく。ログイン画面の
# 「開発用ダミーユーザーでログイン」ボタン（src/lib/dev-login.ts）はこのシークレットが
# 設定されているときだけ出るため、無ければここで用意する。
SECRET_GENERATED=0
if [ -z "${CI_LOGIN_BYPASS_SECRET:-}" ]; then
  GENERATED_SECRET="$(openssl rand -hex 32)"
  bash "$ROOT/scripts/update-env-file.sh" "$ENV_FILE" CI_LOGIN_BYPASS_SECRET "$GENERATED_SECRET"
  SECRET_GENERATED=1
fi

PORT="${PORT:-3000}"

echo
echo "完了しました。"
if [ "$SECRET_GENERATED" -eq 1 ]; then
  # next devは起動時にしか.env.localを読まない。書き足した値は再起動しないと効かない。
  echo "  CI_LOGIN_BYPASS_SECRET を .env.local へ生成しました。**開発サーバーを起こし直してください**（pnpm dev）。"
fi
echo "  http://localhost:${PORT}/login を開き、「開発用ダミーユーザーでログイン」から画面を確認できます。"
