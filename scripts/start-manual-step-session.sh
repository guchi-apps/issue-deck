#!/usr/bin/env bash
# 手作業Issue（`71.manual-step`）を、ユーザーと対話しながら実施するClaude Codeセッションの
# ランチャー（#2771）。
#
# 使い方:
#   scripts/start-manual-step-session.sh <owner> <repo> <issue番号>
#   scripts/start-manual-step-session.sh --prepare-only <owner> <repo> <issue番号>
#
# 呼び出し経路:
#   issue-deckの画面「Claude Codeセッションで進める」（手作業アシスタント・Issue詳細の手作業パネル）
#     → ジョブキュー（kind=MANUAL_STEP_SESSION）→ scripts/subpc-dispatch-poller.sh → このスクリプト
#
# ## 実装セッション（start-issue.sh）との違い
#
#   worktree        作らない。手作業はコードを変えないので、ブランチもコミットも要らない
#   cwd             リポジトリの本体チェックアウト（対応表で解決できるとき）。手作業の手順は
#                   `cd ~/apps/<repo>`のように自分で移動するので、cwdは補助にすぎないが、
#                   そのリポジトリの`CLAUDE.md`が効く・フォルダの信頼確認が済んでいる、という
#                   2点でここを選ぶ。解決できないリポジトリ（cloneが無い）は固定ディレクトリ
#                   （~/apps/issue-deck-worktrees/.manual-steps/_session-<repo>）を使う
#   開発サーバー    起動しない
#   前回の会話      引き継がない（cwdはIssueごとではないため、残っている会話は別の手作業のもの。
#                   横断質問と同じ理由・#1648）
#   成果物          Issue本文のチェック（`- [x]`）と、クローズ時の要約コメント1件だけ
#
# ## 横断質問（start-cross-repo-question.sh）と同じにしているところ
#
#   セッション名は実装セッションと同じ `<リポジトリ名>-issue-<番号>`。**pollerの重複起動ガード・
#   起動成否の差分検出・停止/終了/追加指示の突き合わせ・フックの通知（承認待ち・質問）が
#   すべてこの規約に依存している。** 質問（`AskUserQuestion`）はissue-deckの回答パネルへ出て、
#   Remote Control（`--remote-control`）はrun-issue-session.shが付ける。
#
# ## 歯止め
#
#   このセッションは実装セッションと同じ`auto`モードで動く実行体で、手作業アシスタントの代行実行
#   （`MANUAL_STEP`）が持つ「本文に書かれたコマンドしか実行しない（照合2回）」の歯止めは持たない。
#   代わりにプロンプト（scripts/prompts/manual-step-agent.md）で、**コマンドは実行する前に必ず
#   全文を示して`AskUserQuestion`で聞く**ことを求めている。「自動で最後まで」は持たない
#   （計画レビューの指摘で落とした。docs/multi-agent/gates.md）。
#
# 環境変数:
#   ISSUE_DECK_MANUAL_STEP_BASE         固定ディレクトリの置き場（cloneが無いリポジトリ用）
#   ISSUE_DECK_SHARED_CONTEXT_DIR       共有知識リポジトリ（既定は ~/apps/_docs）
#   ISSUE_DECK_CLAUDE_PERMISSION_MODE   claude の権限モード（既定は auto。#1205）
#   ISSUE_DECK_LAUNCHER_REEXEC          1なら同期コピーからの再実行を行わない（内部用・#1583）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

# 同期コピーから自分自身を実行し直すとき（#1583）にそのまま渡す。下の引数解析は
# `--prepare-only` を取り除いてしまうため、渡された形を先に控えておく。
ORIGINAL_ARGS=(${@+"$@"})

# 対応表の解決・検証は受け口・pollerと共有する（判定を二重に持たない）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/personal-config-sync.sh
source "$SCRIPT_DIR/lib/personal-config-sync.sh"
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$SCRIPT_DIR/lib/launcher-scripts-sync.sh"

usage() {
  echo "Usage: scripts/start-manual-step-session.sh [--prepare-only] <owner> <repo> <issue番号>" >&2
}

PREPARE_ONLY=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

OWNER="$1"
REPO="$2"
ISSUE_NUMBER="$3"
FULL_NAME="$OWNER/$REPO"

local_session_validate_target "$OWNER" "$REPO" "$ISSUE_NUMBER" || exit 1

for required_command in gh python3; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done
if [[ "$PREPARE_ONLY" -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude コマンドが見つかりません。" >&2
  exit 1
fi

# セッション側のスクリプト（run-issue-session.sh・prompts/）は同期コピーから実行する（#1438・#1583）。
resolve_launcher_scripts_dir "$ROOT"
warn_launcher_scripts_stale "$ROOT"
if [[ -n "$LAUNCHER_SCRIPTS_SHA" && "${ISSUE_DECK_LAUNCHER_REEXEC:-0}" != "1" &&
  -f "$LAUNCHER_SCRIPTS_DIR/start-manual-step-session.sh" ]]; then
  echo "情報: ランチャー自身も $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行し直します（#1583）。"
  export ISSUE_DECK_LAUNCHER_REEXEC=1
  export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA="$LAUNCHER_SCRIPTS_SHA"
  export ISSUE_DECK_LAUNCHER_ROOT="$ROOT"
  exec bash "$LAUNCHER_SCRIPTS_DIR/start-manual-step-session.sh" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
fi
warn_personal_config_drift
LAUNCHER_SCRIPTS_SHA="${LAUNCHER_SCRIPTS_SHA:-${ISSUE_DECK_LAUNCHER_SCRIPTS_SHA:-}}"
if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
  echo "情報: セッション側のスクリプトは $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行します（#1438）。"
fi

# --- 作業ディレクトリ ---------------------------------------------------------
# 本体チェックアウトが対応表で解決できればそこ。無ければリポジトリごとの固定ディレクトリ。
# **Issueごとには分けない**（毎回フォルダの信頼確認が出るため。#1529と同じ）。
MANUAL_STEP_BASE="${ISSUE_DECK_MANUAL_STEP_BASE:-$HOME/apps/issue-deck-worktrees/.manual-steps}"
SAFE_REPO="${REPO//[^A-Za-z0-9_-]/-}"
REPO_DIR=""
if REPO_DIR="$(local_repo_resolve_path "$FULL_NAME" 2>/dev/null)" && [[ -d "$REPO_DIR" ]]; then
  SESSION_DIR="$REPO_DIR"
else
  REPO_DIR=""
  SESSION_DIR="$MANUAL_STEP_BASE/_session-$SAFE_REPO"
fi
PROMPT_DIR="$MANUAL_STEP_BASE/.prompts"
PROMPT_FILE="$PROMPT_DIR/$SAFE_REPO-$ISSUE_NUMBER.md"
mkdir -p "$SESSION_DIR" "$PROMPT_DIR"

# --- プロンプトの生成 ----------------------------------------------------------
echo "#$ISSUE_NUMBER: 手作業Issueを取得しています（$FULL_NAME）..."
if ! ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$FULL_NAME" \
  --json number,title,body,comments,labels 2>/dev/null)"; then
  echo "Error: Issue #$ISSUE_NUMBER（$FULL_NAME）を取得できませんでした。" >&2
  exit 1
fi
# 対象は手作業Issueだけ。issue-deck側（`enqueueManualStepSessionJob`）でも見ているが、
# ターミナルから直接叩いた場合のためにここでも確かめる（代行実行のpollerと同じ多層防御）
if ! printf '%s' "$ISSUE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(l.get("name")=="71.manual-step" for l in d.get("labels",[])) else 1)'; then
  echo "Error: Issue #$ISSUE_NUMBER（$FULL_NAME）は手作業Issue（71.manual-step）ではありません。" >&2
  exit 1
fi

PROMPT_TEMPLATE="$LAUNCHER_SCRIPTS_DIR/prompts/manual-step-agent.md"
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: プロンプトのテンプレートがありません（$PROMPT_TEMPLATE）。" >&2
  exit 1
fi

echo "#$ISSUE_NUMBER: 起動用プロンプトを生成しています..."
ISSUE_JSON_FILE="$(mktemp)"
printf '%s' "$ISSUE_JSON" >"$ISSUE_JSON_FILE"
python3 - "$ISSUE_JSON_FILE" "$PROMPT_TEMPLATE" "$FULL_NAME" "$SESSION_DIR" "$REPO_DIR" "$(hostname)" \
  >"$PROMPT_FILE" <<'PY'
import json
import sys

issue_json_path, template_path, repository, session_dir, repo_dir, host_name = sys.argv[1:7]
with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

comments = issue.get("comments", [])
if comments:
    comment_text = "\n\n".join(
        "- {login} ({created_at}):\n{body}".format(
            login=(c.get("author") or {}).get("login", "unknown"),
            created_at=c.get("createdAt", ""),
            body=c.get("body", ""),
        )
        for c in comments
    )
else:
    comment_text = "(コメントなし)"

replacements = {
    "{{ISSUE_NUMBER}}": str(issue["number"]),
    "{{ISSUE_TITLE}}": issue["title"],
    "{{ISSUE_BODY}}": issue.get("body") or "(本文なし)",
    "{{ISSUE_COMMENTS}}": comment_text,
    "{{REPOSITORY}}": repository,
    "{{SESSION_DIR}}": session_dir,
    "{{REPO_DIR}}": f"`{repo_dir}`" if repo_dir else "(このホストにcloneがありません)",
    "{{HOST_NAME}}": host_name,
}
result = template
for placeholder, value in replacements.items():
    result = result.replace(placeholder, value)
sys.stdout.write(result)
PY
rm -f "$ISSUE_JSON_FILE"

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  echo "#$ISSUE_NUMBER: 準備が完了しました。"
  echo "  作業ディレクトリ: $SESSION_DIR"
  echo "  プロンプト: $PROMPT_FILE"
  exit 0
fi

# --- セッションの起動 ---------------------------------------------------------
SESSION_NAME="$SAFE_REPO-issue-$ISSUE_NUMBER"

# tmuxのセッションはtmuxサーバー側の環境を引き継ぐため、このプロセスのexportが届くとは限らない。
# 値は%qでクォートして埋める。
build_env_prefix() {
  local var value prefix=""
  # 開発サーバーは起動しない（手作業に画面を見る用事は無い。要るならセッションの中で起こす）
  prefix+="export ISSUE_DECK_DEV_SERVER=0; "
  prefix+="export ISSUE_DECK_WORKTREE_BASE=$(printf '%q' "$MANUAL_STEP_BASE"); "
  # cwdがgitリポジトリでないことがあるため、セッション名とセッション報告のために渡す（#1454と同じ）
  prefix+="export ISSUE_DECK_REPO_SLUG=$(printf '%q' "$FULL_NAME"); "
  # 回収の条件を実装セッションと分ける印。worktreeを持たないため、質問セッションと同じ
  # 放置の猶予で畳む（scripts/reap-sessions.sh）
  prefix+="export ISSUE_DECK_SESSION_KIND=manual-step; "
  # **前回の会話を引き継がない。** cwdはIssueごとではないので、残っている会話は別の手作業のもの
  prefix+="export ISSUE_DECK_CLAUDE_RESUME=0; "
  for var in ISSUE_DECK_SHARED_CONTEXT_DIR ISSUE_DECK_CLAUDE_PERMISSION_MODE \
    ISSUE_DECK_SESSION_REAPABLE ISSUE_DECK_SESSION_STATE_DIR ISSUE_DECK_CLAUDE_MODEL; do
    value="${!var:-}"
    [[ -n "$value" ]] || continue
    prefix+="export $var=$(printf '%q' "$value"); "
  done
  if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
    prefix+="export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA=$(printf '%q' "$LAUNCHER_SCRIPTS_SHA"); "
    prefix+="export ISSUE_DECK_LAUNCHER_ROOT=$(printf '%q' "${ISSUE_DECK_LAUNCHER_ROOT:-$ROOT}"); "
  fi
  printf '%s' "$prefix"
}

# 開発サーバーのポートは使わないが、run-issue-session.sh の引数は3つ固定なので0を渡す
# （`ISSUE_DECK_DEV_SERVER=0`のため参照されない）。
SESSION_CMD="$(printf "%scd %q && bash %q %q %q %q" "$(build_env_prefix)" "$SESSION_DIR" \
  "$LAUNCHER_SCRIPTS_DIR/run-issue-session.sh" "$ISSUE_NUMBER" "0" "$PROMPT_FILE")"

if ! command -v tmux >/dev/null 2>&1; then
  echo "警告: tmux が見つからないため、このターミナルで起動します（切断するとセッションも終了します）。" >&2
  cd "$SESSION_DIR"
  exec bash -lc "$SESSION_CMD"
fi

if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
  ALIVE_PANES="$(tmux list-panes -s -t "=$SESSION_NAME" -F '#{pane_dead}' 2>/dev/null | grep -cv '^1$' || true)"
  if [[ "${ALIVE_PANES:-0}" -eq 0 ]]; then
    echo "#$ISSUE_NUMBER: 前回のtmuxセッション「$SESSION_NAME」は終了したまま残っていました。最後の出力:"
    tmux capture-pane -p -t "$SESSION_NAME:" 2>/dev/null | grep -v '^$' | tail -n 15 | sed 's/^/    /' || true
    tmux kill-session -t "=$SESSION_NAME" >/dev/null 2>&1 || true
  else
    echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」は既に動いています。新しくは起動しません。"
    exit 0
  fi
fi

echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」で手作業セッションを起動します..."
if ! tmux new-session -d -s "$SESSION_NAME" -c "$SESSION_DIR" "bash -lc $(printf '%q' "$SESSION_CMD")"; then
  echo "Error: tmuxセッション「$SESSION_NAME」の起動に失敗しました。" >&2
  exit 1
fi

tmux set-option -t "$SESSION_NAME:" -w remain-on-exit failed >/dev/null 2>&1 ||
  tmux set-option -t "$SESSION_NAME:" -w remain-on-exit on >/dev/null 2>&1 || true

echo
echo "起動したセッションはこのターミナルを閉じても（SSHが切れても）動き続けます。"
if [[ -n "${TMUX:-}" ]]; then
  echo "  tmux switch-client -t $SESSION_NAME"
elif [[ -t 0 && -t 1 ]]; then
  echo "アタッチします（切り離すには Ctrl-b d）..."
  exec tmux attach-session -t "=$SESSION_NAME"
else
  echo "  tmux attach -t $SESSION_NAME"
fi
