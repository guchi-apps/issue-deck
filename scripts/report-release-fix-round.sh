#!/usr/bin/env bash
# リリース修正の内部確認（#4410）の結果を、issue-deckの報告APIへ送る。
#
# 使い方:
#   scripts/report-release-fix-round.sh status <issue番号>
#   scripts/report-release-fix-round.sh test <issue番号> passed|failed "<要約>"
#   scripts/report-release-fix-round.sh review <issue番号> <レビュー結果JSONファイル>
#
# レビュー結果JSON（独立レビュー担当の報告を実装担当が書き写す）:
#   {"verdict":"pass|findings","summary":"…",
#    "newFindings":[{"title":"…","detail":"…"}],
#    "stillOpen":["F-001"],
#    "resolved":[{"key":"F-002","resolution":"解消を確かめた根拠"}]}
#
# 確認する対象のSHAはサーバーが`issue-<番号>`ブランチのHEADから取り直す。**報告の前にブランチをpushしておく。**
# 出力はAPIの応答（ゲート判定・指摘・上限の消費）。終了コード: 0=記録できた／1=記録されなかった。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/progress-report.sh
source "$ROOT/scripts/lib/progress-report.sh"

action="${1:-}"; issue="${2:-}"
[[ "$action" =~ ^(status|test|review)$ && "$issue" =~ ^[0-9]+$ ]] || { echo "使い方: $0 status|test|review <issue番号> …" >&2; exit 2; }

progress_resolve_endpoint "$ROOT"
[[ -n "$PROGRESS_BASE_URL" && -n "$PROGRESS_SECRET" ]] || { echo "報告先または鍵が見つかりません（APP_BASE_URL・PROGRESS_REPORT_SECRET）" >&2; exit 1; }

repo="$(git -C "$ROOT" remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"

case "$action" in
  status) body="$(jq -n --arg r "$repo" --argjson i "$issue" '{action:"status",repository:$r,issue:$i}')" ;;
  test)
    state="${3:-}"; summary="${4:-}"
    [[ "$state" =~ ^(passed|failed)$ ]] || { echo "stateはpassedかfailed" >&2; exit 2; }
    body="$(jq -n --arg r "$repo" --argjson i "$issue" --arg s "$state" --arg m "$summary" '{action:"test",repository:$r,issue:$i,state:$s,summary:$m}')" ;;
  review)
    file="${3:-}"; [[ -f "$file" ]] || { echo "レビュー結果のJSONファイルを渡してください" >&2; exit 2; }
    body="$(jq --arg r "$repo" --argjson i "$issue" '{action:"review",repository:$r,issue:$i} + .' "$file")" ;;
esac

response="$(curl -sS -m 30 -w '\n%{http_code}' -X POST "$PROGRESS_BASE_URL/api/dispatch/release-fix-internal" \
  -H "Authorization: Bearer $PROGRESS_SECRET" -H 'Content-Type: application/json' --data "$body")"
code="${response##*$'\n'}"; json="${response%$'\n'*}"
echo "$json"
[[ "$code" == "200" ]] || { echo "記録されませんでした（HTTP $code）" >&2; exit 1; }
