#!/usr/bin/env bash
# マニフェストの項目のうち、環境変数として供給されていないものを洗い出す（#1306）。
#
# GitHub側の値は**呼び出し側がジョブの `env:` で明示的に渡す**。このアクションが
# `secrets` コンテキストを丸ごと受け取ることはしない。`toJSON(secrets)` をアクションの
# 入力へ渡すと、ワークフローのrunがaction_requiredになりジョブが1つも作られなくなる
# （PR #1315で実際に発生。ci.ymlのrunが3回とも0ジョブで止まった）。
#
# 複合アクションのステップはジョブの `env:` を引き継ぐが、呼び出し**ステップ**の `env:` は
# 引き継がない。呼び出し側は必ずジョブレベルに書く。
#
# 入力（環境変数）:
#   MANIFEST … 対応表のパス
#   ONLY     … カンマ区切りの対象KEY（空なら全件）
#
# 出力:
#   標準出力に「供給されていないKEYのカンマ区切り」を1行だけ出す
set -euo pipefail

: "${MANIFEST:?MANIFEST is required}"
ONLY="${ONLY:-}"

missing=()
present=0

while IFS=$'\t' read -r key scope kind gh_name source; do
  [[ -z "${key:-}" || "$key" == \#* ]] && continue
  [[ -z "${source:-}" ]] && continue
  if [[ -n "$ONLY" && ",$ONLY," != *",$key,"* ]]; then
    continue
  fi
  if [[ -n "${!key:-}" ]]; then
    present=$((present + 1))
  else
    missing+=("$key")
  fi
done < "$MANIFEST"

echo "環境変数から供給済み: ${present}件、未供給: ${#missing[@]}件" >&2
if [[ ${#missing[@]} -gt 0 ]]; then
  # 名前だけを出す。値は出さない。
  printf '  未供給: %s\n' "$(IFS=, ; echo "${missing[*]}")" >&2
fi

(IFS=, ; echo "${missing[*]:-}")
