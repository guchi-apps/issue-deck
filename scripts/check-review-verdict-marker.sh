#!/usr/bin/env bash
# claude-reviewの判定マーカーが、プロンプトとワークフローで一致しているかを検証する（#2136）。
#
# develop向けPRの意味的判定（claude-review）は、自分では`00.check-user`を付けず、
# 対応Issueへ投稿する理由コメントの末尾へ
#   <!-- issue-deck-review-verdict:merge-blocked sha=<head SHA> -->
# を残す。それを最後の`auto-merge`ジョブ（CIの完了とレビューの完了の両方を待つ唯一のジョブ）が
# 読んでラベルを付ける。
#
# つまりこの文字列は2ファイルにまたがる契約で、**片方だけ変えると、自動マージ不可と判定した
# PRがそのまま自動マージされる**。ワークフロー側は「マーカーが無い＝該当なし」に倒れるため、
# ずれても赤くならず、ログにも異常として出ない。developへ入る前にここで落とす。
set -euo pipefail

cd "$(dirname "$0")/.."

PROMPT=".github/prompts/review-develop.md"
WORKFLOW=".github/workflows/reusable-claude-review-develop.yml"

# プロンプト側はhead SHAを埋め込む前（envsubstの前）なので `sha=${HEAD_SHA}`、
# ワークフロー側は展開後の値を組み立てるので `sha=${HEAD_SHA}`（bashの変数）になる。
# 書式が同じ形に見えるのは偶然ではなく、どちらも同じ1行を作るため。
PROMPT_MARKER='<!-- issue-deck-review-verdict:merge-blocked sha=${HEAD_SHA} -->'
WORKFLOW_MARKER='VERDICT_MARKER="<!-- issue-deck-review-verdict:merge-blocked sha=${HEAD_SHA} -->"'

fail=0

for file in "$PROMPT" "$WORKFLOW"; do
  [ -f "$file" ] || { echo "エラー: $file が見つかりません" >&2; exit 1; }
done

if ! grep -qF "$PROMPT_MARKER" "$PROMPT"; then
  echo "エラー: $PROMPT に判定マーカーの指示が見つかりません。" >&2
  echo "  期待する行: $PROMPT_MARKER" >&2
  fail=1
fi

if ! grep -qF "$WORKFLOW_MARKER" "$WORKFLOW"; then
  echo "エラー: $WORKFLOW に判定マーカーの読み取りが見つかりません。" >&2
  echo "  期待する行: $WORKFLOW_MARKER" >&2
  fail=1
fi

# レビュー側がラベルを付けられる状態に戻っていないか（道具の側の歯止め、#2136）。
if grep -q 'allowedTools .*Bash(gh issue edit' "$WORKFLOW"; then
  echo "エラー: $WORKFLOW のclaude-reviewに Bash(gh issue edit:*) が渡されています。" >&2
  echo "  ラベルを付けるのは auto-merge ジョブだけです（#2136）。" >&2
  fail=1
fi

# 逆に、レビュー結果をPRへ投稿する道具は**必ず渡す**（#2488）。プロンプトは「PRへのコメントとして
# 投稿する」ことと「末尾に総評の判定マーカーを付ける」ことを求めているのに、`gh pr comment`が
# allowedToolsに無かったため、レビューは走っているのに結果が1件も残っていなかった
# （PR本文の`## 検証結果`は`review=unavailable`、リリースPRの表は全行が「記録なし」）。
# prompt modeのclaude-code-actionは結果を自分では投稿しないので、ここが唯一の投稿経路になる。
if ! grep -q 'allowedTools .*Bash(gh pr comment' "$WORKFLOW"; then
  echo "エラー: $WORKFLOW のclaude-reviewに Bash(gh pr comment:*) が渡されていません。" >&2
  echo "  レビュー結果の投稿経路が無くなり、判定も本文も残りません（#2488）。" >&2
  fail=1
fi

# --- ここから、総評の判定マーカーと検証結果の節の契約（#2448）---
#
# 総評の判定マーカーは、レビューが**PRへ**投稿するコメントの末尾に必ず付く。
#   <!-- issue-deck-review-verdict:<判定> sha=<head SHA> -->
# auto-mergeジョブがこれを読んでPR本文へ`## 検証結果`の節を書き、リリースPRがその節を
# 対象issueぶん集めて表にする。**上の merge-blocked とは別の契約**で、あちらは
# 「自動マージを止める合図」、こちらは「何と判定されたかの記録」。
#
# ずれても赤くならないのは merge-blocked と同じで、リリースPRの表が黙って
# 「記録なし」だらけになる。developへ入る前にここで落とす。
RELEASE_WORKFLOW=".github/workflows/reusable-release-develop-to-main.yml"
REVIEW_AGENT_PROMPT="scripts/prompts/review-agent.md"
PARSER="src/lib/github/release-verification.ts"

VERDICT_TEMPLATE='<!-- issue-deck-review-verdict:<判定> sha=${HEAD_SHA} -->'
VERDICT_READ='issue-deck-review-verdict:(lgtm|needs-check|changes-requested) sha=${HEAD_SHA}'
SECTION_START='<!-- issue-deck-verification:start'
SECTION_END='<!-- issue-deck-verification:end -->'
TABLE_HEADING='## コードレビューの検証結果'

for file in "$RELEASE_WORKFLOW" "$REVIEW_AGENT_PROMPT" "$PARSER"; do
  [ -f "$file" ] || { echo "エラー: $file が見つかりません" >&2; exit 1; }
done

if ! grep -qF "$VERDICT_TEMPLATE" "$PROMPT"; then
  echo "エラー: $PROMPT に総評の判定マーカーの指示が見つかりません。" >&2
  echo "  期待する行: $VERDICT_TEMPLATE" >&2
  fail=1
fi

if ! grep -qF "$VERDICT_READ" "$WORKFLOW"; then
  echo "エラー: $WORKFLOW に総評の判定マーカーの読み取りが見つかりません。" >&2
  echo "  期待する文字列: $VERDICT_READ" >&2
  fail=1
fi

# 判定の値そのものも、書く側（プロンプト）に3つとも載っていること。
for verdict in lgtm needs-check changes-requested; do
  if ! grep -qF "\`$verdict\`" "$PROMPT"; then
    echo "エラー: $PROMPT に判定値 \`$verdict\` の説明がありません。" >&2
    fail=1
  fi
done

# 検証結果の節のマーカーは、書く側（レビューのワークフロー・ローカルのレビューエージェント）と
# 読む側（リリースPRの集計）にまたがる。
for file in "$WORKFLOW" "$RELEASE_WORKFLOW" "$REVIEW_AGENT_PROMPT"; do
  if ! grep -qF "$SECTION_START" "$file"; then
    echo "エラー: $file に検証結果の節の開始マーカーがありません。" >&2
    echo "  期待する文字列: $SECTION_START" >&2
    fail=1
  fi
done

# 終了マーカーは、節を置き換える側だけが要る。集計側は開始マーカーの属性しか読まない。
for file in "$WORKFLOW" "$REVIEW_AGENT_PROMPT"; do
  if ! grep -qF "$SECTION_END" "$file"; then
    echo "エラー: $file に検証結果の節の終了マーカーがありません。" >&2
    echo "  期待する文字列: $SECTION_END" >&2
    fail=1
  fi
done

# リリースPR本文の見出しは、書く側（リリースのワークフロー）と読む側（画面のパーサー）の
# 契約。ずれるとパネルが黙って出なくなる。
for file in "$RELEASE_WORKFLOW" "$PARSER"; do
  if ! grep -qF "$TABLE_HEADING" "$file"; then
    echo "エラー: $file にリリースPRの検証結果の見出しがありません。" >&2
    echo "  期待する文字列: $TABLE_HEADING" >&2
    fail=1
  fi
done

# レビューコメント本文の折りたたみ（#2488）も、書く側（リリースのワークフロー）と
# 読む側（画面のパーサー）にまたがる契約。ずれても赤くならず、**判定の表だけが出て本文が
# 出ない**（レビューが何を指摘したのかを読めないまま、mainへのマージを判断することになる）。
DETAIL_START='<!-- issue-deck-review-detail:start'
DETAIL_END='<!-- issue-deck-review-detail:end -->'

for file in "$RELEASE_WORKFLOW" "$PARSER"; do
  if ! grep -qF "$DETAIL_START" "$file"; then
    echo "エラー: $file にレビュー本文の折りたたみの開始マーカーがありません。" >&2
    echo "  期待する文字列: $DETAIL_START" >&2
    fail=1
  fi
  if ! grep -qF "$DETAIL_END" "$file"; then
    echo "エラー: $file にレビュー本文の折りたたみの終了マーカーがありません。" >&2
    echo "  期待する文字列: $DETAIL_END" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: claude-reviewの判定マーカーは $PROMPT と $WORKFLOW で一致しています"
echo "OK: 総評の判定マーカーと検証結果の節の契約も揃っています（#2448）"
echo "OK: レビュー本文の折りたたみのマーカーも揃っています（#2488）"
