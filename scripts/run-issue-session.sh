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
#
# セッションには `--name "<リポジトリ名> #<Issue番号>"` を付ける。Claude Codeはこの名前を
# ターミナルのタイトル（OSC 0）にも出すため、タブを複数開いてもどのリポジトリのどのIssueを
# 見ているかが分かる（#1105）。付けない場合は会話内容から自動命名された名前が出るため、
# タブからIssueを特定できない。
#
# セッションへ最初に渡すプロンプトは、プロンプトファイルの中身そのものではなく「そのファイルを
# 読んで着手せよ」という1行にする（#1105）。届かなかった場合に1行を貼り直すだけで復帰できる。

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

# 前回のセッションがタブの強制終了などでtrapを通らずに終わると、開発サーバーが残ったまま
# ポートを掴んでいることがある。再開時（#1076）にpnpm devが起動できなくなるため先に止める。
if [[ -f "$DEV_PID_FILE" ]]; then
  STALE_PID="$(cat "$DEV_PID_FILE")"
  if [[ "$STALE_PID" =~ ^[0-9]+$ ]] && kill -0 "$STALE_PID" 2>/dev/null; then
    echo "#$ISSUE_NUMBER: 前回の開発サーバー（PID $STALE_PID）が残っているため停止します..."
    kill -TERM "-$STALE_PID" 2>/dev/null || kill -TERM "$STALE_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$STALE_PID" 2>/dev/null || break
      sleep 0.5
    done
  fi
  rm -f "$DEV_PID_FILE"
fi

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
# stdinを/dev/nullにするのは必須（#1094）。set -m によりこのジョブはバックグラウンドの
# プロセスグループになるため、配下のプロセスが端末（tty）から読もうとするとカーネルが
# SIGTTINを送り、プロセスグループごと停止（ps上は T）して誰も再開しない。
# 実際にsetup-lan-access.shが起動するpowershell.exeがこれを踏み、devサーバーが
# 起動しないまま止まっていた。出力はログへ逃がしていたが、stdinがttyのままだった。
pnpm dev </dev/null >"$DEV_LOG" 2>&1 &
DEV_PID=$!
# set -m によりバックグラウンドジョブは新しいプロセスグループを持ち、そのPGIDは先頭プロセスのPIDと一致する。
DEV_PGID="$DEV_PID"
echo "$DEV_PID" >"$DEV_PID_FILE"

# 全アプリ共通の共有知識リポジトリ（guchi-apps/docs）をローカルにcloneしてある場合は、
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

# セッション名（プロンプトボックス・`/resume`の一覧・ターミナルのタイトルに出る）。
# どのリポジトリのどのIssueかがタブから分かるよう「<リポジトリ名> #<Issue番号>」にする（#1105）。
REPO_NAME="$(basename -s .git "$(git config --get remote.origin.url 2>/dev/null || true)")"
if [[ -z "$REPO_NAME" || "$REPO_NAME" == "." ]]; then
  # リモート未設定でも起動は妨げない。worktreeのディレクトリ名で代用する。
  REPO_NAME="$(basename "$PWD")"
fi
SESSION_NAME="$REPO_NAME #$ISSUE_NUMBER"
# --name を解釈しない古いClaude Codeへ渡すと起動自体が失敗するため、対応時のみ付ける。
if claude --help 2>/dev/null | grep -q -- "--name"; then
  CLAUDE_EXTRA_ARGS+=(--name "$SESSION_NAME")
else
  echo "#$ISSUE_NUMBER: 情報: このClaude Codeは --name に未対応のため、タイトルにIssue番号を出しません。" >&2
fi

# セッションへ最初に渡すプロンプト（#1105）。プロンプトファイルの中身をそのまま渡すのではなく、
# 「そのファイルを読んで着手せよ」という1行だけを渡す。理由は3つ。
#
# - 何らかの理由でこのプロンプトがセッションに届かなかったとき、この1行を貼り直すだけで復帰
#   できる。数KBのプロンプト全文を貼り直すのは現実的でない
# - 実装エージェントは起動直後にファイルを読むため、渡した後にプロンプトが再生成されても
#   （同じIssueで再起動した場合など）最新の内容で動く
# - `ps` の出力にIssue本文が丸ごと出るのを避けられる
KICKOFF_PROMPT="Issue #$ISSUE_NUMBER の実装を開始してください。あなたへの指示は $PROMPT_FILE にあります。まずこのファイルを読み、確認を待たずにそのまま指示に従って着手してください。"

# 貼り直し用に、渡すプロンプトを起動前に必ず表示しておく。起動直後のセッションが何も始めない
# 場合（初回起動時のフォルダ信頼確認など、こちらから制御できない要因で失われうる）に、
# ここからコピーすれば実装を始められる。
echo
echo "#$ISSUE_NUMBER: セッションへ次の1行を渡します。もし起動直後に何も始まらなければ、この行を貼り付けてください。"
echo "  $KICKOFF_PROMPT"
echo

# 権限モード（#1205）。既定は `auto`。
# `acceptEdits` はファイル編集だけを自動承認し、Bashコマンドは都度確認するため、
# `npx tsc --noEmit`・`npx vitest run`・`gh issue comment` のたびにセッションが停止する。
# 人が横にいない実行（サブPC・外出先からの起動）ではこれが致命的なので、既定を `auto` にする。
# 代わりに失われる「個々のコマンドを人が目視する機会」は、Pull Request必須・
# `claude-review-develop.yml`のレビュー・自動マージ不可カテゴリ（`00.check-user`）・
# Issueごとのworktree分離という後段の防御で受ける。
# 慎重に進めたいときは ISSUE_DECK_CLAUDE_PERMISSION_MODE=acceptEdits で従来の挙動に戻せる。
# `bypassPermissions` は全権限チェックを飛ばし破壊的な操作も無確認で通るため、既定にはしない。
# 値の妥当性検査はclaude側に任せる（ここで列挙を持つとclaudeの更新でずれる）。不正な値は
# claudeが起動時にエラーで落ちるため、意図しないモードで動き出すことはない。
PERMISSION_MODE="${ISSUE_DECK_CLAUDE_PERMISSION_MODE:-auto}"

echo "#$ISSUE_NUMBER: Claude Codeセッション「$SESSION_NAME」を権限モード $PERMISSION_MODE で起動します..."
# set -u 下で空配列の展開がエラーにならないよう ${arr[@]+...} で囲む
claude --permission-mode "$PERMISSION_MODE" ${CLAUDE_EXTRA_ARGS[@]+"${CLAUDE_EXTRA_ARGS[@]}"} "$KICKOFF_PROMPT"
