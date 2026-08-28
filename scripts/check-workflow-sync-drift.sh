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
  # `|| true` が要るのは `set -e` のため。マーカーの体裁だけを真似た文章
  # （説明のために本文へ書いた `sync-state: ...` など）は `repo=` を持たず grep が exit 1 を返し、
  # 下の「不正な sync-state 記述」のガードへ到達する前にスクリプトごと落ちる。
  # **出力が1行も無いまま exit 1 で終わる**ので、落ちたことにも気付けない（#2435で実際に踏んだ）。
  repo="$(echo "$entry" | grep -oE 'repo=[^ ]+' | cut -d= -f2 || true)"
  workflow="$(echo "$entry" | grep -oE 'workflow=[^ ]+' | cut -d= -f2 || true)"
  base_commit="$(echo "$entry" | grep -oE 'base-commit=[^ ]+' | cut -d= -f2 || true)"

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

# 参照方式(uses: で呼ぶ再利用可能ワークフロー)へ移行したものは、caller側の `@<タグ>` 自体が
# バージョン記録になるため sync-state マーカーを持たず、上記の一覧には現れない(#942)。
# 「出てこないが大丈夫か」と迷わせないための注記。対象は .github/workflows/reusable-*.yml の
# 実在ファイルから導出する（固定文字列で列挙すると、それ自体が腐る手書き台帳になるため）。
shopt -s nullglob
reusables=(.github/workflows/reusable-*.yml)
shopt -u nullglob
if [ "${#reusables[@]}" -gt 0 ]; then
  echo "--- 参照方式のため上記に現れないワークフロー（${#reusables[@]}件） ---"
  for f in "${reusables[@]}"; do
    echo "  $(basename "$f")"
  done
  echo ""
  echo "  これらは各リポジトリがコピーせず uses: で参照している。参照中のバージョンは"
  echo "  対象リポジトリのcallerファイルを見る（docs/supported-repositories.md"
  echo "  「参照方式のワークフローは sync-state の対象外」を参照）。"
  echo "  issue-deck側で切られているタグ:"
  git tag --list 'workflows/*' | sed 's/^/    /' || true
fi
