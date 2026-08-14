#!/usr/bin/env bash
# load-secrets-check.yml の env: ブロックが .github/secrets-manifest.tsv と一致するかを検証する（#1306）。
#
# 複合アクション .github/actions/load-secrets は `secrets` コンテキストを丸ごと受け取れない
# （`toJSON(secrets)` をアクションの入力へ渡すと、ワークフローのrunがaction_requiredになり
# ジョブが1つも作られなくなる。PR #1315で再現・切り分け済み）。そのためGitHub側の値は
# 呼び出し側のジョブに env: で明示的に並べる。
#
# その結果、マニフェストへ項目を足したのに env: へ足し忘れると、検証ワークフローが
# その項目を見ないまま「OK」を出す。**検証していないのに検証したように見える**のが
# 一番まずいので、ズレを機械的に検出する。
#
# YAMLパーサに依存しないよう、生成スクリプトの出力と該当ブロックの行を直接比べる。
set -euo pipefail

cd "$(dirname "$0")/.."

WORKFLOW=".github/workflows/load-secrets-check.yml"
GENERATOR="scripts/generate-workflow-env-block.sh"

[ -f "$WORKFLOW" ] || { echo "エラー: $WORKFLOW が見つかりません" >&2; exit 1; }
[ -x "$GENERATOR" ] || { echo "エラー: $GENERATOR が実行できません" >&2; exit 1; }

expected="$(bash "$GENERATOR")"

# check ジョブの `    env:` から `    steps:` までの間にある、6スペース字下げの行を取り出す。
actual="$(awk '
  /^    env:$/ { inblock = 1; next }
  /^    steps:$/ { inblock = 0 }
  inblock && /^      [A-Za-z_][A-Za-z0-9_]*: / { print }
' "$WORKFLOW")"

if [ -z "$actual" ]; then
  echo "エラー: $WORKFLOW から env: ブロックを取り出せませんでした。" >&2
  echo "ジョブ直下に env: を置く書式が変わった可能性があります。" >&2
  exit 1
fi

if [ "$expected" = "$actual" ]; then
  count="$(printf '%s\n' "$expected" | grep -c .)"
  echo "OK: $WORKFLOW の env: ブロックは .github/secrets-manifest.tsv と一致しています（${count}件）"
  exit 0
fi

echo "エラー: $WORKFLOW の env: ブロックが .github/secrets-manifest.tsv と一致しません。" >&2
echo "" >&2
echo "--- 期待（マニフェストから生成） / +++ 実際（ワークフロー） ---" >&2
diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") >&2 || true
echo "" >&2
echo "次のコマンドの出力で env: ブロックを置き換えてください:" >&2
echo "  $GENERATOR" >&2
exit 1
