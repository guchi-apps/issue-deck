#!/usr/bin/env bash
# 1Passwordへフォールバックする項目だけを並べた env テンプレートを生成する（#1306）。
#
# 1password/load-secrets-action は OP_ENV_FILE に書かれた**全行**を解決する。
# ファイル全体を渡すと不要な項目まで取りに行き、サービスアカウントの日次レート制限
# （1Passwordアカウント全体で1,000リクエスト/日）を無駄に消費する。必要な項目だけを書く。
#
# 入力（環境変数）:
#   MANIFEST … 対応表のパス
#   KEYS     … カンマ区切りの対象KEY（空なら何も書かず、生成しない）
#   OUT      … 出力先のパス
#
# 出力:
#   標準出力に「生成したかどうか（true/false）」を1行だけ出す
set -euo pipefail

: "${MANIFEST:?MANIFEST is required}"
: "${OUT:?OUT is required}"
KEYS="${KEYS:-}"

if [[ -z "$KEYS" ]]; then
  echo "1Passwordへのフォールバックは不要（未解決の項目なし）" >&2
  echo "false"
  exit 0
fi

: > "$OUT"
written=0
skipped=()

while IFS=$'\t' read -r key scope kind gh_name source; do
  [[ -z "${key:-}" || "$key" == \#* ]] && continue
  [[ -z "${source:-}" ]] && continue
  [[ ",$KEYS," != *",$key,"* ]] && continue

  # inherit は organization secret 由来で1Password側に対応する参照が無い。
  if [[ "$scope" == "inherit" || "$source" == "-" ]]; then
    skipped+=("$key")
    continue
  fi

  printf '%s=%s\n' "$key" "$source" >> "$OUT"
  written=$((written + 1))
done < "$MANIFEST"

if [[ ${#skipped[@]} -gt 0 ]]; then
  echo "1Passwordに対応する参照が無いため対象外: $(IFS=, ; echo "${skipped[*]}")" >&2
fi

if [[ "$written" -eq 0 ]]; then
  rm -f "$OUT"
  echo "1Passwordから取得できる未解決項目は無し" >&2
  echo "false"
  exit 0
fi

echo "1Passwordへフォールバックする項目: ${written}件" >&2
echo "true"
