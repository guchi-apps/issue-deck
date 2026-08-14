#!/usr/bin/env bash
# マニフェストの全項目が環境変数として解決できたかを検証する（#1306）。
#
# 失敗時は**名前だけ**を報告する。値は絶対に出さない。
# issue-deckはPUBLICリポジトリでActionsのログが誰でも読める。
set -euo pipefail

: "${MANIFEST:?MANIFEST is required}"
ONLY="${ONLY:-}"

missing=()
ok=0

while IFS=$'\t' read -r key scope kind gh_name source; do
  [[ -z "${key:-}" || "$key" == \#* ]] && continue
  [[ -z "${source:-}" ]] && continue
  if [[ -n "$ONLY" && ",$ONLY," != *",$key,"* ]]; then
    continue
  fi
  if [[ -n "${!key:-}" ]]; then
    ok=$((ok + 1))
  else
    missing+=("$key")
  fi
done < "$MANIFEST"

echo "解決済み: ${ok}件"

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "::error::次の項目をどちらの供給元からも解決できませんでした: $(IFS=, ; echo "${missing[*]}")"
  echo "GitHub側のsecret/variableが未投入の場合は scripts/sync-github-secrets.sh で投入してください。" >&2
  echo "1Passwordへのフォールバックを使う場合は op-token を渡してください。" >&2
  exit 1
fi
