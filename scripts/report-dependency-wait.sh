#!/usr/bin/env bash
# 実装セッションが「依存先を待って保留する」ことをissue-deckへ構造化して報告する（#4321）。
#
# Claude Code・Codexのどちらのセッションからも同じ形で呼ぶ。**自由文の最終回答やIssueコメントだけで
# 保留を終えない**ための入口で、依存先・再開条件・短い日本語の理由が揃わなければ送らない。
# 登録時にissue-deckが依存先の現在の状態を確認するため、成立済みならすぐ再開の指示が戻ってくる。
#
# 使い方:
#   scripts/report-dependency-wait.sh <owner/repo> <Issue番号> <依存先owner/repo> <依存先番号> <issue|pr> \
#     <条件(カンマ区切り: closed,merged,released,verified)> "<保留理由（日本語・1行）>"
#
# 条件の意味:
#   closed   依存先がクローズされる
#   merged   依存先のPRがマージされる
#   released 依存先のPRの内容が本番（main）へ反映される
#   verified 実環境での検証が済む（人の確認が必要。自動では成立しない）
#
# **このスクリプトは待機の登録だけを行う。** 再開はissue-deckが条件の成立を確認して、固定の
# 1行をこのセッションへ送る。`11.local`は付けたままでよい。
set -euo pipefail

if [[ $# -ne 7 ]]; then
  echo "usage: $0 <owner/repo> <issue> <dep-owner/repo> <dep-number> <issue|pr> <conditions> <reason>" >&2
  exit 2
fi

repository="$1" issue="$2" dep_repo="$3" dep_number="$4" dep_kind="$5" conditions="$6" reason="$7"

env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
[[ -f "$env_file" ]] || { echo "dispatch.envが見つかりません: $env_file" >&2; exit 1; }
# shellcheck disable=SC1090
source "$env_file"
[[ -n "${APP_BASE_URL:-}" && -n "${DISPATCH_SECRET:-}" ]] || { echo "APP_BASE_URL/DISPATCH_SECRETが未設定です" >&2; exit 1; }

body="$(jq -n \
  --arg repository "$repository" --argjson issue "$issue" \
  --arg depRepo "$dep_repo" --argjson depNumber "$dep_number" --arg depKind "$dep_kind" \
  --arg conditions "$conditions" --arg reason "$reason" \
  '{repository: $repository, issue: $issue,
    dependency: {repository: $depRepo, number: $depNumber, kind: $depKind},
    conditions: ($conditions | split(",")), reason: $reason}')"

curl -fsS --max-time 30 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DISPATCH_SECRET" \
  -d "$body" \
  "${APP_BASE_URL%/}/api/dispatch/sessions/dependency-wait"
echo
