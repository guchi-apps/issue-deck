#!/usr/bin/env bash
# 「おまかせ」のモデル判定の当たり外れを、モデル別・判定経路別のやり直し率と費用で出す（#4852）。
#
# 使い方:
#   scripts/model-pick-outcomes.sh               直近90日をモデル×経路×確率帯の表で出す
#   scripts/model-pick-outcomes.sh --days 180    集計する日数（上限180）
#   scripts/model-pick-outcomes.sh --issues      Issueごとの明細も出す
#   scripts/model-pick-outcomes.sh --json        受け口の応答をそのまま出す
#
# 宛先と鍵は`~/.config/issue-deck/dispatch.env`の`APP_BASE_URL`・`DISPATCH_SECRET`
# （`ISSUE_DECK_DISPATCH_ENV`で別のファイルを指せる）。
#
# ## なぜ要るか
#
# Sonnet 5.5とOpus 5.5の単価差は2倍にとどまり、Sonnetがやり直しを1回起こすと節約分は消える。
# 判定の基準（Jevの確率しきい値・ルールでSonnetへ振る範囲）を勘ではなくデータで見直すための計器。
# 指標の定義と見直しの判断基準は docs/multi-agent/prompts-and-models.md「判定の当たり外れを測る」。
#
# **これは計器であって役ではない**（LLMを使わず、判断もしない）。集計は受け口
# （`GET /api/dispatch/model-pick-outcomes`・`src/lib/model-pick-outcomes.ts`）が行い、ここは整形だけ。

set -euo pipefail

CONFIG_FILE="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
DAYS=90
SHOW_ISSUES=0
OUTPUT="table"

usage() {
  awk 'NR == 1 { next } /^# ## / { exit } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) DAYS="${2:?--days には日数を指定してください}"; shift 2 ;;
    --issues) SHOW_ISSUES=1; shift ;;
    --json) OUTPUT="json"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Error: 不明な引数: $1" >&2; usage >&2; exit 1 ;;
  esac
done
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "Error: --days は正の整数で指定してください" >&2; exit 1; }

dispatch_env_value() {
  local name="$1"
  if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    (set +eu; source "$CONFIG_FILE" >/dev/null 2>&1; printf '%s' "${!name:-}")
    return 0
  fi
  printf '%s' "${!name:-}"
}

BASE_URL="$(dispatch_env_value APP_BASE_URL)"
SECRET="$(dispatch_env_value DISPATCH_SECRET)"
if [[ -z "$BASE_URL" || -z "$SECRET" ]]; then
  echo "Error: 宛先（APP_BASE_URL）か鍵（DISPATCH_SECRET）が見つかりません（$CONFIG_FILE）" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

# 鍵はコマンドライン引数に載せない（`ps`から見えるため）。`--header @-`で標準入力から渡す
response="$(printf 'Authorization: Bearer %s\n' "$SECRET" |
  curl --silent --show-error --fail --max-time 60 --header @- \
    "$BASE_URL/api/dispatch/model-pick-outcomes?days=$DAYS")"

if [[ "$OUTPUT" == "json" ]]; then
  printf '%s\n' "$response"
  exit 0
fi

printf '%s' "$response" | jq -r '"直近\(.days)日・\(.issues | length)件のIssue（Claudeの起動ジョブがあったもの）\n"'
printf '%s' "$response" | jq -r '
  (["モデル", "経路", "確率帯", "件数", "やり直し率", "再起動", "修復", "上書き", "平均費用"] | @tsv),
  (.groups[] | [
    .model, .route, .jevBand, .issues,
    "\((.redoRate * 100) | round)% (\(.redoIssues))",
    .relaunches, .repairs,
    (if .comparable > 0 then "\(.overridden)/\(.comparable)" else "-" end),
    "$\((.avgCostUsd * 100 | round) / 100)"
  ] | @tsv)
' | column -t -s $'\t'

if [[ "$SHOW_ISSUES" -eq 1 ]]; then
  echo
  printf '%s' "$response" | jq -r '
    (["Issue", "モデル", "経路", "判定", "確率帯", "再起動", "CI", "競合", "PR修復", "レビュー修正", "費用"] | @tsv),
    (.issues | sort_by(.repositoryFullName, .issueNumber)[] | [
      "\(.repositoryFullName)#\(.issueNumber)", .model, .route, (.pickedModel // "-"), .jevBand,
      .relaunches, .repairs["ci-fix"], .repairs["conflict-resolve"], .repairs["pr-repair"], .repairs["review-fix"],
      "$\((.costUsd * 100 | round) / 100)"
    ] | @tsv)
  ' | column -t -s $'\t'
fi
