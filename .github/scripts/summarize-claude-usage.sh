#!/usr/bin/env bash
# claude-code-actionのexecution_fileから、そのステップのトークン使用量・ターン数・所要時間・
# 権限拒否を抽出し、GitHub ActionsのJob Summaryへ表として出力する（#903）。
#
# これまで1 runあたりのコストやターン数を知るにはexecution_fileのJSONを掘る必要があり、
# 実質的に誰も見ていなかった。トークン削減の施策（#910）を入れても、効果が測れなければ
# 「安くなったのか、単に手を抜くようになったのか」を区別できないため、まず可視化する。
#
# 使い方:
#   .github/scripts/summarize-claude-usage.sh "<ステップ名>" "<execution_fileのパス>"
#
# **このスクリプトは絶対にジョブを失敗させない。** 計測はあくまで補助情報であり、
# execution_fileが無い・スキーマが変わった・jqが失敗した場合でも、本来の処理（実装・レビュー等）
# の成否に影響を与えてはならない。そのため set -e は使わず、全ての抽出を || true で保護する。
#
# execution_fileのJSON構造はclaude-code-action側の内部実装詳細であり、スキーマは変わりうる
# （claude-issue-dispatch.ymlのフォールバック処理と同じ前提）。抽出できなかった項目は "-" と
# 表示し、値の欠落自体は異常として扱わない。

set -uo pipefail

STEP_LABEL="${1:-（名称不明のステップ）}"
EXECUTION_FILE="${2:-}"

# Job Summaryの出力先。ローカル実行時など未設定の場合は標準出力へ流す。
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ -z "$EXECUTION_FILE" ] || [ ! -f "$EXECUTION_FILE" ]; then
  {
    echo "### Claude使用量: ${STEP_LABEL}"
    echo ""
    echo "execution_fileが取得できなかったため、使用量を集計できませんでした。"
    echo ""
  } >> "$SUMMARY_FILE"
  exit 0
fi

# 最後のresultターンに、そのステップ全体の累計が入っている。
RESULT_JSON="$(jq -c '[.[] | select(.type == "result")] | last // {}' "$EXECUTION_FILE" 2>/dev/null || echo '{}')"

get() {
  printf '%s' "$RESULT_JSON" | jq -r "$1 // empty" 2>/dev/null || true
}

COST="$(get '.total_cost_usd')"
TURNS="$(get '.num_turns')"
DURATION_MS="$(get '.duration_ms')"
API_MS="$(get '.duration_api_ms')"
SUBTYPE="$(get '.subtype')"
IS_ERROR="$(get '.is_error')"
DENIED="$(printf '%s' "$RESULT_JSON" | jq -r '(.permission_denials // []) | map(.tool_name // .tool // "?") | unique | join(", ")' 2>/dev/null || true)"

# usageは入力の内訳（キャッシュ作成・キャッシュ読み出し・非キャッシュ入力）と出力。
# キャッシュ読み出しが支配的になるのが通常で、ここが極端に大きいステップは
# 「大きいファイルを文脈に載せたまま何ターンも回している」ことを示す。
IN_TOKENS="$(get '.usage.input_tokens')"
OUT_TOKENS="$(get '.usage.output_tokens')"
CACHE_CREATE="$(get '.usage.cache_creation_input_tokens')"
CACHE_READ="$(get '.usage.cache_read_input_tokens')"

# 表示の整形。いずれも空文字を渡されたら "-" を返し、値が無いこと自体は異常として扱わない。

# 秒に丸める（ミリ秒のままだと表が読みにくいため）。
to_seconds() {
  [ -n "${1:-}" ] || { printf '%s' "-"; return; }
  awk -v ms="$1" 'BEGIN { printf "%.0f秒", ms / 1000 }' 2>/dev/null || printf '%s' "-"
}

# トークン数は7桁を超えることがあるため3桁区切りにする。
to_commas() {
  [ -n "${1:-}" ] || { printf '%s' "-"; return; }
  printf '%s' "$1" | sed -E ':a;s/([0-9])([0-9]{3})($|[^0-9])/\1,\2\3/;ta' 2>/dev/null || printf '%s' "$1"
}

# コストは有効数字が多すぎると読みにくいため4桁に丸める。
to_usd() {
  [ -n "${1:-}" ] || { printf '%s' "-"; return; }
  awk -v v="$1" 'BEGIN { printf "$%.4f", v }' 2>/dev/null || printf '$%s' "$1"
}

row() {
  printf '| %s | %s |\n' "$1" "${2:--}"
}

{
  echo "### Claude使用量: ${STEP_LABEL}"
  echo ""
  echo "| 項目 | 値 |"
  echo "| --- | --- |"
  row "API換算コスト" "$(to_usd "$COST")"
  row "ターン数" "$TURNS"
  row "所要時間" "$(to_seconds "$DURATION_MS")"
  row "うちAPI待ち" "$(to_seconds "$API_MS")"
  row "出力トークン" "$(to_commas "$OUT_TOKENS")"
  row "入力トークン（非キャッシュ）" "$(to_commas "$IN_TOKENS")"
  row "入力トークン（キャッシュ作成）" "$(to_commas "$CACHE_CREATE")"
  row "入力トークン（キャッシュ読み出し）" "$(to_commas "$CACHE_READ")"
  row "終了種別" "$SUBTYPE"
  echo ""

  # 権限拒否は1件でも「プロンプトが指示している操作がallowedToolsに無い」設定漏れの可能性が高い。
  # 拒否1回はそのまま1往復であり、その時点の文脈をまるごと再送するため、放置するとコストに効く。
  if [ -n "$DENIED" ]; then
    echo "⚠️ **権限拒否されたツール**: \`${DENIED}\`"
    echo ""
    echo "プロンプトが指示している操作が \`--allowedTools\` に含まれていない可能性があります。拒否1回につき1往復ぶんのトークンが無駄になります。"
    echo ""
  fi

  if [ "$IS_ERROR" = "true" ]; then
    echo "⚠️ このステップはエラーで終了しています（\`is_error: true\`）。"
    echo ""
  fi
} >> "$SUMMARY_FILE"

exit 0
