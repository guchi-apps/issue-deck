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

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: claude-reviewの判定マーカーは $PROMPT と $WORKFLOW で一致しています"
