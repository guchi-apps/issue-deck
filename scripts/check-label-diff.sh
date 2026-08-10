#!/usr/bin/env bash
# issue-deckと展開先リポジトリのGitHubラベルの差分を可視化する。
# どのラベルを揃えるか・揃えないかの判断はユーザーに委ね、本スクリプトは差分の出力のみ行う。
set -euo pipefail

SOURCE_REPO="guchi-apps/issue-deck"

if [ $# -ne 1 ]; then
  echo "使い方: $0 <owner/repo>" >&2
  echo "例: $0 m-guchi/shopping-list" >&2
  exit 1
fi

TARGET_REPO="$1"

for cmd in gh jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "エラー: ${cmd} コマンドが見つかりません" >&2
    exit 1
  fi
done

SOURCE_JSON="$(gh api "repos/${SOURCE_REPO}/labels" --paginate)"
TARGET_JSON="$(gh api "repos/${TARGET_REPO}/labels" --paginate)"

SOURCE_NAMES="$(echo "$SOURCE_JSON" | jq -r '.[].name' | sort -u)"
TARGET_NAMES="$(echo "$TARGET_JSON" | jq -r '.[].name' | sort -u)"

echo "=== ${SOURCE_REPO} のみに存在するラベル ==="
comm -23 <(echo "$SOURCE_NAMES") <(echo "$TARGET_NAMES")

echo ""
echo "=== ${TARGET_REPO} のみに存在するラベル ==="
comm -13 <(echo "$SOURCE_NAMES") <(echo "$TARGET_NAMES")

echo ""
echo "=== 両方に存在するが色・説明文が異なるラベル ==="
comm -12 <(echo "$SOURCE_NAMES") <(echo "$TARGET_NAMES") | while IFS= read -r name; do
  [ -z "$name" ] && continue
  src="$(echo "$SOURCE_JSON" | jq -r --arg n "$name" '.[] | select(.name == $n) | "\(.color)\t\(.description)"')"
  tgt="$(echo "$TARGET_JSON" | jq -r --arg n "$name" '.[] | select(.name == $n) | "\(.color)\t\(.description)"')"
  if [ "$src" != "$tgt" ]; then
    printf '%s\n  %s: color=%s description=%s\n  %s: color=%s description=%s\n' \
      "$name" \
      "$SOURCE_REPO" "$(echo "$src" | cut -f1)" "$(echo "$src" | cut -f2-)" \
      "$TARGET_REPO" "$(echo "$tgt" | cut -f1)" "$(echo "$tgt" | cut -f2-)"
  fi
done
