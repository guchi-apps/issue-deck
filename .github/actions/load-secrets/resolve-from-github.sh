#!/usr/bin/env bash
# マニフェストに従い、GitHubのsecret/variableから環境変数を組み立てて $GITHUB_ENV へ書く（#1306）。
#
# 値そのものは絶対に出力しない。解決できなかった項目は**名前だけ**を報告する。
# issue-deckはPUBLICリポジトリでActionsのログが誰でも読める。
#
# 入力（環境変数）:
#   MANIFEST     … 対応表のパス
#   SECRETS_JSON … 呼び出し側の toJSON(secrets)
#   VARS_JSON    … 呼び出し側の toJSON(vars)
#   ONLY         … カンマ区切りの対象KEY（空なら全件）
#   SKIP_PRESENT … true なら既に環境変数がある項目を飛ばす（フォールバックの2周目で使う）
#
# 出力:
#   標準出力に「解決できなかったKEYのカンマ区切り」を1行だけ出す
set -euo pipefail

: "${MANIFEST:?MANIFEST is required}"
: "${SECRETS_JSON:?SECRETS_JSON is required}"
: "${VARS_JSON:?VARS_JSON is required}"
ONLY="${ONLY:-}"
SKIP_PRESENT="${SKIP_PRESENT:-false}"

missing=()
resolved=0

# GITHUB_ENVへは heredoc 形式で書く。SSH秘密鍵のような複数行の値を壊さないため。
# 区切り文字は値と衝突しないよう毎回ランダムに生成する（値に区切り文字を仕込まれると
# 別の環境変数を注入できてしまうため、固定値にはしない）。
write_env() {
  local name="$1" value="$2" delim
  delim="EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  {
    printf '%s<<%s\n' "$name" "$delim"
    printf '%s\n' "$value"
    printf '%s\n' "$delim"
  } >> "$GITHUB_ENV"
}

while IFS=$'\t' read -r key scope kind gh_name source; do
  [[ -z "${key:-}" || "$key" == \#* ]] && continue
  [[ -z "${source:-}" ]] && continue
  if [[ -n "$ONLY" && ",$ONLY," != *",$key,"* ]]; then
    continue
  fi
  if [[ "$SKIP_PRESENT" == "true" && -n "${!key:-}" ]]; then
    continue
  fi

  # inherit は organization secret をそのまま使う。GitHub側の名前はKEYと同じ。
  if [[ "$kind" == "var" ]]; then
    value="$(printf '%s' "$VARS_JSON" | jq -r --arg n "$gh_name" '.[$n] // empty')"
  else
    value="$(printf '%s' "$SECRETS_JSON" | jq -r --arg n "$gh_name" '.[$n] // empty')"
  fi

  if [[ -z "$value" ]]; then
    missing+=("$key")
    continue
  fi

  write_env "$key" "$value"
  resolved=$((resolved + 1))
done < "$MANIFEST"

echo "GitHubから解決: ${resolved}件、未解決: ${#missing[@]}件" >&2
if [[ ${#missing[@]} -gt 0 ]]; then
  # 名前だけを出す。値は出さない。
  printf '  未解決: %s\n' "$(IFS=, ; echo "${missing[*]}")" >&2
fi

(IFS=, ; echo "${missing[*]:-}")
