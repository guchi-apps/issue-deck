#!/usr/bin/env bash
# リモートセッションのランチャー（#4743）。Issueに紐づかず、リポジトリだけを指定して
# Claude Codeのセッション（`--remote-control`付き）を立てる。会話はClaude Codeアプリ側で行う。
#
# 使い方:
#   scripts/start-remote-session.sh <owner> <repo> <セッション名>          起動する
#   scripts/start-remote-session.sh --kill <owner> <repo> <セッション名>   畳んでworktreeを片付ける
#   scripts/start-remote-session.sh --sweep                                 tmuxの無いworktreeを片付ける
#   scripts/start-remote-session.sh --kill-name <セッション名>              名前だけで畳む（無操作の自動終了。#4871）
#
# 呼び出し経路:
#   issue-deckの画面「リモートセッション」→ ジョブキュー（kind=REMOTE_SESSION / REMOTE_SESSION_KILL）
#     → scripts/subpc-dispatch-poller.sh → このスクリプト
#
# ## 実装セッション（run-issue-session.sh）との違い
#
#   セッション名    `<リポジトリ名>-remote-<8文字>`（issue-deckが決めてジョブに載せる）。
#                   `-issue-<番号>`の規約から外すので、引き上げ・停滞検知・自動再開・回収の
#                   対象に混ざらない
#   作業場所        既定ブランチ（`origin/HEAD`）の最新からdetachedで作るworktree
#                   （`~/apps/<repo>-worktrees/remote-<8文字>`）。本体チェックアウトは使わない
#                   （pollerの自己更新・他セッションと作業ツリーを取り合うため）。フォルダの信頼確認は
#                   本体チェックアウトで判定され、worktreeでは出ない（scripts/lib/claude-trust.sh）
#   フック          渡さない（`--settings`を付けない）。issue-deckの実装セッション向けの報告が
#                   飛ぶと、Issueに紐づかないセッションが`DispatchSession`へ混ざるため
#   権限モード      `ISSUE_DECK_CLAUDE_PERMISSION_MODE`（既定auto。実装セッションと同じ）
#   開発サーバー    起動しない（要ればセッションの中で起こす）
#
# ## 片付け
#
# worktreeは**作業が残っていないときだけ**消す（未コミットの変更が無く、HEADがどのリモート
# ブランチからも辿れる）。残っていれば消さずにパスを出す。会話はClaude Codeアプリ側にあるが、
# 作業ツリーはサブPCにしか無いため、勝手に消すと取り返せない。
#
# 環境変数:
#   ISSUE_DECK_CLAUDE_PERMISSION_MODE   claude の権限モード（既定は auto）
#   ISSUE_DECK_CLAUDE_MODEL             claude の --model（未設定ならCLIの既定）
#   ISSUE_DECK_REMOTE_SWEEP_MIN_AGE     --sweep で片付けるまでの猶予秒（既定600。起動直後を消さない）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/claude-trust.sh
source "$SCRIPT_DIR/lib/claude-trust.sh"

# issue-deckの`REMOTE_SESSION_NAME_PATTERN`と同じ形
NAME_PATTERN='^[A-Za-z0-9_-]+-remote-[a-z0-9]{8}$'

usage() {
  echo "Usage: scripts/start-remote-session.sh [--kill] <owner> <repo> <セッション名>" >&2
  echo "       scripts/start-remote-session.sh --sweep" >&2
  echo "       scripts/start-remote-session.sh --kill-name <セッション名>" >&2
}

worktree_base_for() {
  printf '%s/apps/%s-worktrees' "$HOME" "$1"
}

# セッション名の末尾8文字（`remote-<8文字>`のディレクトリ名に使う）
session_suffix() {
  printf '%s' "${1##*-remote-}"
}

# worktreeに作業が残っていないか。残っていなければ0
worktree_is_disposable() {
  local dir="$1"
  [[ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ]] || return 1
  # HEADがどのリモートブランチからも辿れない＝pushしていないコミットがある
  [[ -z "$(git -C "$dir" rev-list -n 1 HEAD --not --remotes 2>/dev/null)" ]] || return 1
  # ブランチを切ってコミットした場合も、pushしていなければ上で拾える。ブランチだけ作って
  # 切り替えたままのworktreeは、ブランチが残るので作業ツリーは消してよい
  return 0
}

remove_worktree() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  if ! worktree_is_disposable "$dir"; then
    echo "作業内容が残っているため、worktreeは残しました: $dir"
    return 0
  fi
  local common_dir
  common_dir="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_dir" ]]; then
    git -C "$(dirname "$common_dir")" worktree remove --force "$dir" >/dev/null 2>&1 || true
    git -C "$(dirname "$common_dir")" worktree prune >/dev/null 2>&1 || true
  fi
  [[ -d "$dir" ]] && echo "worktreeを削除できませんでした: $dir" >&2
  [[ ! -d "$dir" ]] && echo "worktreeを削除しました: $dir"
  return 0
}

MODE=launch
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --kill) MODE=kill ;;
    --sweep) MODE=sweep ;;
    --kill-name) MODE=kill_name ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

# --- 掃除: tmuxセッションが無くなったworktreeを片付ける -------------------------
if [[ "$MODE" == "sweep" ]]; then
  min_age="${ISSUE_DECK_REMOTE_SWEEP_MIN_AGE:-600}"
  now="$(date +%s)"
  live="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"
  shopt -s nullglob
  for dir in "$HOME"/apps/*-worktrees/remote-*; do
    [[ -d "$dir" ]] || continue
    base="$(basename "$(dirname "$dir")")"
    repo="${base%-worktrees}"
    safe_repo="${repo//[^A-Za-z0-9_-]/-}"
    name="$safe_repo-remote-${dir##*/remote-}"
    printf '%s\n' "$live" | grep -qxF "$name" && continue
    mtime="$(stat -c %Y "$dir" 2>/dev/null || echo "$now")"
    ((now - mtime >= min_age)) || continue
    remove_worktree "$dir"
  done
  exit 0
fi

# --- 名前だけで畳む: pollerの無操作の自動終了（#4871）から呼ぶ -------------------------
# セッション名にはリポジトリ名を`-`へ置き換えた形しか残らないため、worktreeは末尾8文字
# （起動ごとにランダム）で`~/apps/*-worktrees/remote-<8文字>`を引く
if [[ "$MODE" == "kill_name" ]]; then
  if [[ $# -ne 1 || ! "$1" =~ $NAME_PATTERN ]]; then
    usage
    exit 2
  fi
  SESSION_NAME="$1"
  if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "=$SESSION_NAME"
    echo "tmuxセッション「$SESSION_NAME」を終了しました。"
  fi
  shopt -s nullglob
  for dir in "$HOME"/apps/*-worktrees/remote-"$(session_suffix "$SESSION_NAME")"; do
    remove_worktree "$dir"
  done
  exit 0
fi

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

OWNER="$1"
REPO="$2"
SESSION_NAME="$3"
FULL_NAME="$OWNER/$REPO"

if [[ ! "$SESSION_NAME" =~ $NAME_PATTERN ]]; then
  echo "Error: セッション名の形が不正です: $SESSION_NAME" >&2
  exit 2
fi

WORKTREE_DIR="$(worktree_base_for "$REPO")/remote-$(session_suffix "$SESSION_NAME")"

# --- 終了 ---------------------------------------------------------------------
if [[ "$MODE" == "kill" ]]; then
  if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "=$SESSION_NAME"
    echo "tmuxセッション「$SESSION_NAME」を終了しました。"
  else
    echo "tmuxセッション「$SESSION_NAME」は既にありません。"
  fi
  remove_worktree "$WORKTREE_DIR"
  exit 0
fi

# --- 起動 ---------------------------------------------------------------------
if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
  echo "tmuxセッション「$SESSION_NAME」は既に動いています。"
  exit 0
fi

if ! REPO_PATH="$(local_repo_resolve_path "$FULL_NAME")" || [[ ! -d "$REPO_PATH/.git" && ! -f "$REPO_PATH/.git" ]]; then
  echo "Error: $FULL_NAME のチェックアウトがこのホストにありません（~/.config/issue-deck/local-repos.conf）。" >&2
  exit 1
fi

# 未信頼のまま起こすと信頼確認で止まり、Remote Controlも繋がらない。起こす前に案内して止める
claude_trust_require "$REPO_PATH" "$FULL_NAME"

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude コマンドが見つかりません。" >&2
  exit 1
fi
if ! claude --help 2>/dev/null | grep -q -- "--remote-control"; then
  echo "Error: このClaude Codeは --remote-control に対応していません（claude update を実行してください）。" >&2
  exit 1
fi

# 既定ブランチ（develop / main が混在するため origin/HEAD から引く）
git -C "$REPO_PATH" fetch --quiet origin
BASE_REF="$(git -C "$REPO_PATH" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
if [[ -z "$BASE_REF" ]]; then
  for candidate in origin/develop origin/main origin/master; do
    if git -C "$REPO_PATH" rev-parse --verify --quiet "$candidate" >/dev/null; then
      BASE_REF="$candidate"
      break
    fi
  done
fi
if [[ -z "$BASE_REF" ]]; then
  echo "Error: $FULL_NAME の既定ブランチを特定できませんでした。" >&2
  exit 1
fi

mkdir -p "$(dirname "$WORKTREE_DIR")"
if [[ ! -d "$WORKTREE_DIR" ]]; then
  git -C "$REPO_PATH" worktree add --quiet --detach "$WORKTREE_DIR" "$BASE_REF"
fi

PERMISSION_MODE="${ISSUE_DECK_CLAUDE_PERMISSION_MODE:-auto}"
CLAUDE_ARGS=(--remote-control "$SESSION_NAME" --name "$SESSION_NAME" --permission-mode "$PERMISSION_MODE")
if [[ -n "${ISSUE_DECK_CLAUDE_MODEL:-}" && "${ISSUE_DECK_CLAUDE_MODEL}" != "auto" ]]; then
  CLAUDE_ARGS+=(--model "$ISSUE_DECK_CLAUDE_MODEL")
fi

SESSION_CMD="cd $(printf '%q' "$WORKTREE_DIR") && exec claude"
for arg in "${CLAUDE_ARGS[@]}"; do
  SESSION_CMD+=" $(printf '%q' "$arg")"
done

echo "tmuxセッション「$SESSION_NAME」でリモートセッションを起動します（$FULL_NAME・$BASE_REF）..."
if ! tmux new-session -d -s "$SESSION_NAME" -c "$WORKTREE_DIR" "bash -lc $(printf '%q' "$SESSION_CMD")"; then
  echo "Error: tmuxセッション「$SESSION_NAME」の起動に失敗しました。" >&2
  remove_worktree "$WORKTREE_DIR"
  exit 1
fi
echo "作業ディレクトリ: $WORKTREE_DIR"
