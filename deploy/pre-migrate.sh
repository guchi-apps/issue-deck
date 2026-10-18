#!/usr/bin/env bash
# app-deploy-gate がマイグレーションの直前に呼ぶ（guchi-apps/vps#300・#4804）。
# gate は DATABASE_URL・MIGRATE_DATABASE_URL をマイグレーション用の接続先にして、置き場で実行する。
#
# 失敗した記録が _prisma_migrations に残っていると以降のデプロイが P3018 で止まり続けるため、
# 個別の補修スクリプトで未完了の記録をロールバック扱いにしてから prisma migrate deploy へ進む。
# 以前は deploy.yml の SSH 先スクリプトが `DATABASE_URL="$MIGRATE_DATABASE_URL" node …` で
# 同じ3本を実行していた。gate の外ではスクリプトを動かせないため、ここへ移した。
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/repair-failed-codex-weekly-floor.mjs
node scripts/repair-failed-dispatch-session-codex-thread-id.mjs
node scripts/repair-failed-pull-request-auto-repair-loop.mjs
