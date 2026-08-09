#!/usr/bin/env bash
# .github/workflows/*.yml から抽出できる識別子（ワークフローファイル名・ラベル名・Secrets名）が
# docs/cross-repo-setup-guide.md 本文に記載されているかを検証する。
# 記載内容が実態と意味的に正しいかまでは保証しない、存在チェックのみ。
set -euo pipefail

cd "$(dirname "$0")/.."

GUIDE="docs/cross-repo-setup-guide.md"
WORKFLOWS_DIR=".github/workflows"

if [ ! -f "$GUIDE" ]; then
  echo "エラー: $GUIDE が見つかりません" >&2
  exit 1
fi

# 対象0件を「問題なし」と報告しない（#937）。globが展開されないまま処理が進むと、
# 実態を検査せずに終わる・意味の分からないエラーになる、のどちらかになる。
shopt -s nullglob
workflow_files=("$WORKFLOWS_DIR"/*.yml)
shopt -u nullglob
if [ "${#workflow_files[@]}" -eq 0 ]; then
  echo "エラー: $WORKFLOWS_DIR/*.yml が1件も見つかりません。リポジトリルートで実行しているか確認してください。" >&2
  exit 1
fi

missing=0

check() {
  local kind="$1"
  local id="$2"
  if ! grep -qF -- "$id" "$GUIDE"; then
    echo "未記載 [$kind]: $id" >&2
    missing=1
  fi
}

# 1. ワークフローファイル名
for f in "${workflow_files[@]}"; do
  check "workflow" "$(basename "$f")"
done

# 2. ラベル名（2桁数字プレフィックス付き文字列リテラル。例: 01.planning, 03.d:marge）
# IPアドレス（127.0.0.1等）を誤検出しないよう、プレフィックス直後は英字始まりのみに限定する。
labels="$(grep -rhoE '[0-9]{2}\.[A-Za-z][A-Za-z0-9:_-]*' "$WORKFLOWS_DIR"/*.yml | sort -u)"
while IFS= read -r label; do
  [ -z "$label" ] && continue
  check "label" "$label"
done <<<"$labels"

# 3. Secrets名（secrets.XXX パターン）
secrets="$(grep -rhoE 'secrets\.[A-Za-z0-9_]+' "$WORKFLOWS_DIR"/*.yml | sed 's/^secrets\.//' | sort -u)"
while IFS= read -r secret; do
  [ -z "$secret" ] && continue
  check "secret" "$secret"
done <<<"$secrets"

if [ "$missing" -ne 0 ]; then
  echo "" >&2
  echo "$GUIDE に上記の識別子が記載されていません。ワークフローの変更に合わせてドキュメントを更新してください。" >&2
  exit 1
fi

echo "OK: $GUIDE は現在の $WORKFLOWS_DIR/*.yml（${#workflow_files[@]}ファイル）の識別子と同期しています"
