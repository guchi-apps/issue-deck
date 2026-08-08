#!/usr/bin/env bash
# Issue専用worktreeの開発サーバー（pnpm dev）をバックグラウンドで自動起動したうえで、
# Claude Codeセッションをフォアグラウンドで実行するラッパー。
# セッション終了時（正常終了・ターミナルclose・kill等）にtrapで開発サーバーも自動停止する。
#
# 使い方:
#   scripts/run-issue-session.sh <issue番号> <devポート> <プロンプトファイルパス>
#
# 呼び出し元（start-issue.sh）が事前に対象worktreeディレクトリへcdしている前提で、
# カレントディレクトリを基準に pnpm dev を起動する。

set -euo pipefail
set -m

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/run-issue-session.sh <issue番号> <devポート> <プロンプトファイルパス>" >&2
  exit 1
fi

ISSUE_NUMBER="$1"
DEV_PORT="$2"
PROMPT_FILE="$3"

WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"
DEV_LOG="$DEV_SERVER_DIR/issue-$ISSUE_NUMBER.log"
DEV_PID_FILE="$DEV_SERVER_DIR/issue-$ISSUE_NUMBER.pid"

mkdir -p "$DEV_SERVER_DIR"

DEV_PGID=""

cleanup() {
  if [[ -n "$DEV_PGID" ]]; then
    echo "#$ISSUE_NUMBER: 開発サーバー（プロセスグループ $DEV_PGID）を停止しています..."
    kill -TERM "-$DEV_PGID" 2>/dev/null || true
  fi
  rm -f "$DEV_PID_FILE"
}
trap cleanup EXIT HUP TERM

echo "#$ISSUE_NUMBER: 開発サーバーをポート $DEV_PORT でバックグラウンド起動しています（ログ: $DEV_LOG）..."
pnpm dev >"$DEV_LOG" 2>&1 &
DEV_PID=$!
# set -m によりバックグラウンドジョブは新しいプロセスグループを持ち、そのPGIDは先頭プロセスのPIDと一致する。
DEV_PGID="$DEV_PID"
echo "$DEV_PID" >"$DEV_PID_FILE"

# 全アプリ共通の共有知識リポジトリ（m-guchi/docs）をローカルにcloneしてある場合は、
# --add-dir でworktree外のそのディレクトリも参照できるようにする（docs/shared-knowledge.md
# 「8. Claude Codeへのコンテキストの渡し方」）。cloneしていない環境でも起動できるよう、
# 存在しない場合は --add-dir を付けずにそのまま起動する。
SHARED_CONTEXT_DIR="${ISSUE_DECK_SHARED_CONTEXT_DIR:-$HOME/apps/_docs}"
CLAUDE_EXTRA_ARGS=()
if [[ -d "$SHARED_CONTEXT_DIR" ]]; then
  CLAUDE_EXTRA_ARGS+=(--add-dir "$SHARED_CONTEXT_DIR")
  echo "#$ISSUE_NUMBER: 共有知識リポジトリを参照可能にします: $SHARED_CONTEXT_DIR"
else
  echo "#$ISSUE_NUMBER: 共有知識リポジトリ（$SHARED_CONTEXT_DIR）が見つからないため、参照なしで起動します。"
fi

echo "#$ISSUE_NUMBER: Claude Codeセッションを起動します..."
# set -u 下で空配列の展開がエラーにならないよう ${arr[@]+...} で囲む
claude --permission-mode acceptEdits ${CLAUDE_EXTRA_ARGS[@]+"${CLAUDE_EXTRA_ARGS[@]}"} "$(cat "$PROMPT_FILE")"
