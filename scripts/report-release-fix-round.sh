#!/usr/bin/env bash
# リリース修正の内部確認（#4410）の結果を、issue-deckの報告APIへ送る。
#
# 使い方:
#   scripts/report-release-fix-round.sh status <issue番号>
#   scripts/report-release-fix-round.sh test <issue番号> passed|failed "<要約>"
#   scripts/report-release-fix-round.sh review <issue番号> <レビュー結果JSONファイル>
#   scripts/report-release-fix-round.sh claim <issue番号> <担当名> [takeover]   … 担当を取得（takeoverで別担当から引き継ぎ）。応答のepochを控える
#   scripts/report-release-fix-round.sh release <issue番号>                    … 担当を解放（記録は保持）
#   scripts/report-release-fix-round.sh pause <issue番号> environment|needs_decision "<理由>"  … 実行環境の障害・判断や権限の不足で一時停止
#   scripts/report-release-fix-round.sh resume <issue番号>                      … 回復済みの実行障害だけ、入力なしで再開
#
# 担当を取ったら環境変数 RELEASE_FIX_ASSIGNEE（担当名）と RELEASE_FIX_EPOCH（claimの応答のepoch）を設定する。
# review・test・release・pause・resumeへ自動で添える。担当が変わった後の旧担当の遅延報告は記録されない。
# statusは読み取り専用（停止・再開・コメント・ラベルの操作をしない）。予算の追加・方針が要る再開は画面から行う。
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
[[ "$action" =~ ^(status|test|review|claim|release|pause|resume)$ && "$issue" =~ ^[0-9]+$ ]] || { echo "使い方: $0 status|test|review <issue番号> …" >&2; exit 2; }

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
  claim)
    who="${3:-}"; [[ -n "$who" ]] || { echo "担当名を渡してください" >&2; exit 2; }
    takeover=false; [[ "${4:-}" == "takeover" ]] && takeover=true
    body="$(jq -n --arg r "$repo" --argjson i "$issue" --arg a "$who" --argjson t "$takeover" '{action:"claim",repository:$r,issue:$i,assignee:$a,takeover:$t}')" ;;
  release) body="$(jq -n --arg r "$repo" --argjson i "$issue" '{action:"release",repository:$r,issue:$i}')" ;;
  resume) body="$(jq -n --arg r "$repo" --argjson i "$issue" '{action:"resume",repository:$r,issue:$i}')" ;;
  pause)
    kind="${3:-}"; detail="${4:-}"
    [[ "$kind" =~ ^(environment|needs_decision)$ ]] || { echo "kindはenvironmentかneeds_decision" >&2; exit 2; }
    body="$(jq -n --arg r "$repo" --argjson i "$issue" --arg k "$kind" --arg d "$detail" '{action:"pause",repository:$r,issue:$i,kind:$k,detail:$d}')" ;;
esac

# 担当と世代番号を添える（担当が変わった後の旧担当の報告をサーバーが弾く）
if [[ -n "${RELEASE_FIX_ASSIGNEE:-}" && "$action" != "status" && "$action" != "claim" ]]; then
  body="$(jq --arg a "$RELEASE_FIX_ASSIGNEE" --arg e "${RELEASE_FIX_EPOCH:-}" '. + {assignee:$a} + (if $e == "" then {} else {epoch:($e|tonumber)} end)' <<<"$body")"
fi

response="$(curl -sS -m 30 -w '\n%{http_code}' -X POST "$PROGRESS_BASE_URL/api/dispatch/release-fix-internal" \
  -H "Authorization: Bearer $PROGRESS_SECRET" -H 'Content-Type: application/json' --data "$body")"
code="${response##*$'\n'}"; json="${response%$'\n'*}"
echo "$json"
[[ "$code" == "200" ]] || { echo "記録されませんでした（HTTP $code）" >&2; exit 1; }
