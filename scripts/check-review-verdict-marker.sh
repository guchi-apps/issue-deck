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
CODEX_PROMPT="scripts/prompts/codex-pr-review-agent.md"
CODEX_RUNNER="scripts/start-codex-pr-review.sh"

# プロンプト側はhead SHAを埋め込む前（envsubstの前）なので `sha=${HEAD_SHA}`、
# ワークフロー側は展開後の値を組み立てるので `sha=${HEAD_SHA}`（bashの変数）になる。
# 書式が同じ形に見えるのは偶然ではなく、どちらも同じ1行を作るため。
PROMPT_MARKER='<!-- issue-deck-review-verdict:merge-blocked sha=${HEAD_SHA} -->'
WORKFLOW_MARKER='VERDICT_MARKER="<!-- issue-deck-review-verdict:merge-blocked sha=${HEAD_SHA} -->"'

fail=0

for file in "$PROMPT" "$WORKFLOW"; do
  [ -f "$file" ] || { echo "エラー: $file が見つかりません" >&2; exit 1; }
done

# CodexのレビューはサブPC上のChatGPTサブスクリプションで実行する。GitHub Actionsが残す
# 要求印と、Codexの出力を検証して投稿する側の判定印がずれると、待機がタイムアウトして
# 自動マージが常に止まるか、別SHAの結果を誤って読む。3ファイルで固定する。
CODEX_REQUEST='issue-deck-codex-review-request sha='
CODEX_VERDICT='issue-deck-codex-review-verdict:'
for file in "$WORKFLOW" "$CODEX_RUNNER"; do
  if ! grep -qF "$CODEX_REQUEST" "$file"; then
    echo "エラー: $file にCodexレビュー要求の印がありません。" >&2
    fail=1
  fi
  if ! grep -qF "$CODEX_VERDICT" "$file"; then
    echo "エラー: $file にCodexレビュー判定の印がありません。" >&2
    fail=1
  fi
done
if ! grep -qF '<!-- issue-deck-codex-review-verdict:<判定> sha={{HEAD_SHA}} -->' "$CODEX_PROMPT"; then
  echo "エラー: $CODEX_PROMPT にCodexレビュー判定の指示がありません。" >&2
  fail=1
fi

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

# 総評の判定マーカーは、PRのレビューコメントを読む側にもまたがる（#2849）。マージ待ちの
# 承認カードは、このマーカーが付いたコメントを「いま読むべきレビュー」として選び、指摘を
# 修正依頼へ取り込ませる。ずれると**パネルごと出なくなり**（＝レビューが無いのと同じ見た目）、
# 指摘を読まないままマージを押せてしまう。
COMMENT_PARSER="src/lib/github/pull-request-review-comment.ts"
[ -f "$COMMENT_PARSER" ] || { echo "エラー: $COMMENT_PARSER が見つかりません" >&2; exit 1; }

if ! grep -qF "issue-deck-(?:codex-)?review-verdict:(lgtm|needs-check|changes-requested)" "$COMMENT_PARSER"; then
  echo "エラー: $COMMENT_PARSER に総評の判定マーカーの読み取りが見つかりません。" >&2
  echo "  期待する文字列: issue-deck-(?:codex-)?review-verdict:(lgtm|needs-check|changes-requested)" >&2
  fail=1
fi

# 転記されたレビュー（#2488）の印も同じ扱い。判定は無いが本文は読めるので、こちらも拾う
if ! grep -qF "issue-deck-review-report" "$COMMENT_PARSER"; then
  echo "エラー: $COMMENT_PARSER に転記されたレビューの印の読み取りが見つかりません。" >&2
  echo "  期待する文字列: issue-deck-review-report" >&2
  fail=1
fi

# 検証結果の節のマーカーは、書く側（レビューのワークフロー・ローカルのレビューエージェント）と
# 読む側（リリースPRの集計・マージ確認ダイアログのパーサー。#2843）にまたがる。
# 画面側がずれると、マージを押す直前の判定が黙って「記録がありません」になる。
VERDICT_PARSER="src/lib/github/pull-request-review-verdict.ts"
[ -f "$VERDICT_PARSER" ] || { echo "エラー: $VERDICT_PARSER が見つかりません" >&2; exit 1; }

for file in "$WORKFLOW" "$RELEASE_WORKFLOW" "$REVIEW_AGENT_PROMPT" "$VERDICT_PARSER"; do
  if ! grep -qF "$SECTION_START" "$file"; then
    echo "エラー: $file に検証結果の節の開始マーカーがありません。" >&2
    echo "  期待する文字列: $SECTION_START" >&2
    fail=1
  fi
done

# 終了マーカーは、節を置き換える側と、節の範囲を切り出して読む側が要る。リリースPRの集計は
# 開始マーカーの属性しか読まないので対象外。
for file in "$WORKFLOW" "$REVIEW_AGENT_PROMPT" "$VERDICT_PARSER"; do
  if ! grep -qF "$SECTION_END" "$file"; then
    echo "エラー: $file に検証結果の節の終了マーカーがありません。" >&2
    echo "  期待する文字列: $SECTION_END" >&2
    fail=1
  fi
done

# 判定時点のコミット（#3172）は、書く側（レビューのワークフロー・ローカルのレビュー
# エージェント）と読む側（画面のパーサー）にまたがる。**ずれても赤くならず、画面の
# 「この判定の後にコミットが積まれています」が黙って出なくなる**——修正を積んだ後も
# 修正前の「要修正」がそのまま出る状態（#3172の起点）へ戻る。
# 節そのものは`sha=`が無くても読めるよう作ってあるので、ここで落とすしかない。
# **開始マーカーの属性にしていないのは、古い読み手を黙って壊さないため。** `review=`・`risk=`の
# 直後が`-->`である前提で読んでいる版（この変更より前の画面。本番へ出るのはリリース後）は、
# 属性が増えた瞬間に節ごと「記録なし」へ倒れ、要修正のPRでマージ警告が消える。
SECTION_SHA_WRITE='<!-- issue-deck-verification:sha=${HEAD_SHA} -->'
SECTION_SHA_READ='issue-deck-verification:sha=([0-9a-fA-F]+)'

if ! grep -qF "$SECTION_SHA_WRITE" "$WORKFLOW"; then
  echo "エラー: $WORKFLOW の検証結果の節に判定時点のコミット（sha=）の行がありません。" >&2
  echo "  期待する行: $SECTION_SHA_WRITE" >&2
  fail=1
fi

if ! grep -qF '<!-- issue-deck-verification:sha=<レビューしたときのhead SHA> -->' "$REVIEW_AGENT_PROMPT"; then
  echo "エラー: $REVIEW_AGENT_PROMPT の検証結果の節に判定時点のコミット（sha=）の指示がありません。" >&2
  fail=1
fi

if ! grep -qF "$SECTION_SHA_READ" "$VERDICT_PARSER"; then
  echo "エラー: $VERDICT_PARSER に判定時点のコミット（sha=）の読み取りがありません。" >&2
  echo "  期待する文字列: $SECTION_SHA_READ" >&2
  fail=1
fi

# 開始マーカーへ属性を足していないことも見張る（上のコメントの理由）。
if grep -qE 'issue-deck-verification:start[^>]*sha=' "$WORKFLOW" "$REVIEW_AGENT_PROMPT"; then
  echo "エラー: 検証結果の開始マーカーへ属性（sha=）を足しています。" >&2
  echo "  古い読み手が節ごと読めなくなるため、判定時点のコミットは節の中の別行に置きます（#3172）。" >&2
  fail=1
fi

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

# --- レビュー指摘の自動修正への渡し（#3363）---
#
# 2つの印が3ファイルにまたがる。**どちらもずれても赤くならない**——自動修正OKの印が読めないと
# 常に人へ渡り（機能が黙って止まる）、渡しの印が読めないと`claude-review-fix.yml`が着手せず、
# **00.check-userも付かないまま「要修正」のPRが放置される**。
FIX_WORKFLOW=".github/workflows/reusable-claude-review-fix.yml"
[ -f "$FIX_WORKFLOW" ] || { echo "エラー: $FIX_WORKFLOW が見つかりません" >&2; exit 1; }

AUTOFIX_PROMPT='<!-- issue-deck-review-autofix:ok sha=${HEAD_SHA} -->'
AUTOFIX_READ='AUTOFIX_MARKER="<!-- issue-deck-review-autofix:ok sha=${HEAD_SHA} -->"'
HANDOFF_WRITE='<!-- issue-deck-review-fix:handoff sha=${HEAD_SHA} -->'
HANDOFF_READ='HANDOFF="<!-- issue-deck-review-fix:handoff sha=${HEAD_SHA} -->"'

if ! grep -qF "$AUTOFIX_PROMPT" "$PROMPT"; then
  echo "エラー: $PROMPT に自動修正OKの印の指示が見つかりません。" >&2
  echo "  期待する行: $AUTOFIX_PROMPT" >&2
  fail=1
fi
if ! grep -qF "$AUTOFIX_READ" "$WORKFLOW"; then
  echo "エラー: $WORKFLOW に自動修正OKの印の読み取りが見つかりません。" >&2
  echo "  期待する行: $AUTOFIX_READ" >&2
  fail=1
fi
if ! grep -qF "$HANDOFF_WRITE" "$WORKFLOW"; then
  echo "エラー: $WORKFLOW に自動修正への渡しの印の書き込みが見つかりません。" >&2
  echo "  期待する文字列: $HANDOFF_WRITE" >&2
  fail=1
fi
if ! grep -qF "$HANDOFF_READ" "$FIX_WORKFLOW"; then
  echo "エラー: $FIX_WORKFLOW に自動修正への渡しの印の読み取りが見つかりません。" >&2
  echo "  期待する行: $HANDOFF_READ" >&2
  fail=1
fi

# --- 修正Issueが指す対象PR（#3634）---
#
# 修正Issueの本文の`対応PR: #<番号>`（リリースの検証結果から起票）・`対象PR: #<番号>`
# （PR詳細から起票）は、リリースのワークフローが「このPRは同じリリースの修正Issueで直った」と
# 読む材料。**ずれても赤くならず、作り直したリリースで直したはずのPRが要修正のまま残る**。
FIX_ISSUE_DRAFT="src/lib/github/pull-request-fix-issue.ts"
[ -f "$FIX_ISSUE_DRAFT" ] || { echo "エラー: $FIX_ISSUE_DRAFT が見つかりません" >&2; exit 1; }

if ! grep -qF '`- 対応PR: ${row.pullRequestNumber !== null ? `#' "$PARSER"; then
  echo "エラー: $PARSER の修正Issueの下書きに「- 対応PR: #<番号>」の行が見つかりません。" >&2
  fail=1
fi
if ! grep -qF 'TARGET_PULL_REQUEST_MARKER_PREFIX = "対象PR: #"' "$FIX_ISSUE_DRAFT"; then
  echo "エラー: $FIX_ISSUE_DRAFT の修正Issueのマーカーが「対象PR: #」ではありません。" >&2
  fail=1
fi
if ! grep -qF '(対応PR|対象PR): #([0-9]+)' "$RELEASE_WORKFLOW"; then
  echo "エラー: $RELEASE_WORKFLOW に修正Issueの対象PRの読み取りが見つかりません。" >&2
  echo "  期待する文字列: (対応PR|対象PR): #([0-9]+)" >&2
  fail=1
fi

# --- 「確認済み・対応しない」の記録（#3739）---
#
# 画面（`review-acknowledgement.ts`）が投稿する記録のコメントの印を、リリースのワークフローが読む。
# **ずれても赤くならず、記録したはずの指摘が次のリリースでも要確認のまま残る**。
ACK_LIB="src/lib/github/review-acknowledgement.ts"
[ -f "$ACK_LIB" ] || { echo "エラー: $ACK_LIB が見つかりません" >&2; exit 1; }
if ! grep -qF 'REVIEW_ACK_MARKER_PREFIX = "issue-deck-review-ack"' "$ACK_LIB"; then
  echo "エラー: $ACK_LIB の記録の印が issue-deck-review-ack ではありません。" >&2
  fail=1
fi
for needle in 'issue-deck-review-ack sha=' 'issue-deck-review-ack-revoke sha=' '"issue-deck[bot]" and .user.type == "Bot"'; do
  if ! grep -qF "$needle" "$RELEASE_WORKFLOW"; then
    echo "エラー: $RELEASE_WORKFLOW に記録の読み取り（$needle）が見つかりません。" >&2
    fail=1
  fi
done
if ! grep -qF '確認済み（元の判定: ' "$RELEASE_WORKFLOW" || ! grep -qF '元の判定: ${VERDICT_LABEL' "$ACK_LIB"; then
  echo "エラー: 確認済みのセルの文言が $RELEASE_WORKFLOW と $ACK_LIB で揃っていません。" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: claude-reviewの判定マーカーは $PROMPT と $WORKFLOW で一致しています"
echo "OK: 総評の判定マーカーと検証結果の節の契約も揃っています（#2448）"
echo "OK: レビュー本文の折りたたみのマーカーも揃っています（#2488）"
echo "OK: マージ待ちのレビュー指摘パネルの読み取りも揃っています（#2849）"
echo "OK: 判定時点のコミット（sha=）の書き込みと読み取りも揃っています（#3172）"
echo "OK: レビュー指摘の自動修正への渡しの印も揃っています（#3363）"
echo "OK: 修正Issueが指す対象PRの書き込みと読み取りも揃っています（#3634）"
echo "OK: 「確認済み・対応しない」の記録の書き込みと読み取りも揃っています（#3739）"
