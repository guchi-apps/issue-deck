#!/usr/bin/env bash
# 実装セッションが「他リポジトリにも修正が要る」と判断したとき、issue-deckへ子Issueの起票と
# 実装セッションの起動を依頼する（#5421）。
#
# Claude Code・Codexのどちらのセッションからも同じ形で呼ぶ。**自分で`gh issue create --repo`を
# 打たず、他リポジトリのファイルも触らない**ための入口。issue-deckが次を行う。
#   1. 起票先へ子Issueを作る（同じ<key>で再送しても重複しない）
#   2. 起点IssueのサブIssueへ紐付ける
#   3. 起点と同じホスト・エージェントで子の実装セッションを起動する（--no-launchで起票のみ）
#   4. 起点Issueへ結果をコメントする
#
# 使い方:
#   scripts/report-cross-repo-issue.sh <起点owner/repo> <起点Issue番号> <起票先owner/repo> <key> \
#     "<タイトル>" <本文ファイル> [--wait-origin] [--no-launch]
#
#   key            小文字・数字・ハイフン3〜64文字。同じ依頼を同定する（例: fix-token-decrypt）
#   本文ファイル   子Issueの本文（目的・完了条件）。起点へのリンクとマーカーはissue-deckが足す
#   --wait-origin  子が起点の実装（developへのマージ）を待つ必要があるとき。子の本文の
#                  `## 前提条件`に起点が入り、起動した子セッションが依存待ち（#4321）で待つ
#   --no-launch    起票と紐付けだけ行い、子の実装セッションは起動しない
#
# 起点が子の完了を待つ必要があるときは、このあと`scripts/report-dependency-wait.sh`で保留を報告する。
set -euo pipefail

if [[ $# -lt 6 ]]; then
  echo "usage: $0 <owner/repo> <issue> <target-owner/repo> <key> <title> <body-file> [--wait-origin] [--no-launch]" >&2
  exit 2
fi

repository="$1" issue="$2" target="$3" key="$4" title="$5" body_file="$6"
shift 6
wait_origin=false launch=true
for arg in "$@"; do
  case "$arg" in
    --wait-origin) wait_origin=true ;;
    --no-launch) launch=false ;;
    *) echo "不明な引数です: $arg" >&2; exit 2 ;;
  esac
done
[[ -f "$body_file" ]] || { echo "本文ファイルが見つかりません: $body_file" >&2; exit 2; }

env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
[[ -f "$env_file" ]] || { echo "dispatch.envが見つかりません: $env_file" >&2; exit 1; }
# shellcheck disable=SC1090
source "$env_file"
[[ -n "${APP_BASE_URL:-}" && -n "${DISPATCH_SECRET:-}" ]] || { echo "APP_BASE_URL/DISPATCH_SECRETが未設定です" >&2; exit 1; }

body="$(jq -n \
  --arg repository "$repository" --argjson issue "$issue" \
  --arg target "$target" --arg key "$key" --arg title "$title" \
  --rawfile issueBody "$body_file" \
  --argjson waitForOrigin "$wait_origin" --argjson launch "$launch" \
  '{repository: $repository, issue: $issue,
    requests: [{key: $key, targetRepository: $target, title: $title, body: $issueBody,
                waitForOrigin: $waitForOrigin, launch: $launch}]}')"

curl -sS --fail-with-body --max-time 120 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DISPATCH_SECRET" \
  -d "$body" \
  "${APP_BASE_URL%/}/api/dispatch/cross-repo-issues"
echo
