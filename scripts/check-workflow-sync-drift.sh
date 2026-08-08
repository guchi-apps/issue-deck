#!/usr/bin/env bash
# docs/supported-repositories.md に記録された sync-state マーカー
# (<!-- sync-state: repo=<owner/repo> workflow=<file> base-commit=<SHA> -->) を読み取り、
# issue-deck側でそのワークフローファイルにbase-commit以降加わった変更を一覧表示する。
# あくまでissue-deck自身のgit履歴のみで完結する情報表示であり、対象リポジトリ側で
# 実際に変更が取り込まれたかどうかまでは判別できない。
set -euo pipefail

cd "$(dirname "$0")/.."

DOC="docs/supported-repositories.md"

if [ ! -f "$DOC" ]; then
  echo "エラー: $DOC が見つかりません" >&2
  exit 1
fi

mapfile -t entries < <(grep -oE '<!-- sync-state:[^>]*-->' "$DOC" || true)

if [ "${#entries[@]}" -eq 0 ]; then
  echo "sync-state の記録が $DOC に見つかりませんでした。導入済みリポジトリがあれば追記してください。"
  exit 0
fi

for entry in "${entries[@]}"; do
  repo="$(echo "$entry" | grep -oE 'repo=[^ ]+' | cut -d= -f2)"
  workflow="$(echo "$entry" | grep -oE 'workflow=[^ ]+' | cut -d= -f2)"
  base_commit="$(echo "$entry" | grep -oE 'base-commit=[^ ]+' | cut -d= -f2)"

  if [ -z "$repo" ] || [ -z "$workflow" ] || [ -z "$base_commit" ]; then
    echo "警告: 不正な sync-state 記述をスキップします: $entry" >&2
    continue
  fi

  workflow_path=".github/workflows/${workflow}"
  if [ ! -f "$workflow_path" ]; then
    echo "警告: ${workflow_path} が見つかりません（${repo} 向けの記録: $entry）" >&2
    continue
  fi

  if ! git cat-file -e "${base_commit}" 2>/dev/null; then
    echo "警告: base-commit ${base_commit} がこのリポジトリの履歴に見つかりません（${repo} / ${workflow}）" >&2
    continue
  fi

  echo "=== ${repo} / ${workflow}（base: ${base_commit}） ==="
  diff_log="$(git log --oneline "${base_commit}..HEAD" -- "$workflow_path")"
  if [ -z "$diff_log" ]; then
    echo "  差分なし（導入時点から変更はありません）"
  else
    echo "$diff_log" | sed 's/^/  /'
  fi
  echo ""
done
