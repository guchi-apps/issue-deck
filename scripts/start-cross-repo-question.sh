#!/usr/bin/env bash
# 複数リポジトリ横断の質問セッションのランチャー（#1454）。
#
# 使い方:
#   scripts/start-cross-repo-question.sh <owner> <repo> <issue番号>
#   scripts/start-cross-repo-question.sh --prepare-only <owner> <repo> <issue番号>
#
# 引数の `<owner>/<repo>` と `<issue番号>` は**質問Issueの置き場所**で、参照範囲ではない。
# 参照するのは「このホストが実行できると申告した全リポジトリ」（`local_repo_list_runnable`）で、
# それらのチェックアウトを `--add-dir` で渡す。
#
# 呼び出し経路:
#   issue-deckの画面「質問する」→「複数のリポジトリ（横断）」
#     → ジョブキュー（kind=CROSS_REPO_QUESTION）→ scripts/subpc-dispatch-poller.sh → このスクリプト
#
# ## 実装セッション（generic-start-issue.sh）との違い
#
#   worktree        作らない。**読み取り専用**なのでブランチもコミットも要らない
#   cwd             質問ごとの空ディレクトリ（~/apps/issue-deck-worktrees/.questions/<repo>-<番号>）。
#                   どれか1つのリポジトリをcwdにすると、そのリポジトリのCLAUDE.mdだけが
#                   最初から効いてしまい、横断の質問なのに視点が偏る
#   開発サーバー    起動しない
#   書き込みツール  `--disallowedTools`で封じる（プロンプトの指示だけに頼らない）
#   成果物          質問Issueへ投稿する回答コメント1件だけ
#
# セッション名は実装セッションと同じ `<リポジトリ名>-issue-<番号>` にする。**pollerの重複起動
# ガード・起動成否の差分検出・停止/終了/追加指示の突き合わせがすべてこの規約に依存している。**
#
# 環境変数:
#   ISSUE_DECK_QUESTION_BASE            質問セッションの作業ディレクトリの置き場
#   ISSUE_DECK_SHARED_CONTEXT_DIR       共有知識リポジトリ（既定は ~/apps/_docs）
#   ISSUE_DECK_CLAUDE_PERMISSION_MODE   claude の権限モード（既定は auto。#1205）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

# 対応表の解決・検証は受け口・pollerと共有する（判定を二重に持たない）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# 個人設定・共有知識の同期の取り残しの警告（#1190）。
# shellcheck source=scripts/lib/personal-config-sync.sh
source "$SCRIPT_DIR/lib/personal-config-sync.sh"
# 起動スクリプト自身（issue-deckの本体の作業ツリー）が古いままの場合の警告（#1274・#1438）。
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$SCRIPT_DIR/lib/launcher-scripts-sync.sh"

usage() {
  echo "Usage: scripts/start-cross-repo-question.sh [--prepare-only] <owner> <repo> <issue番号>" >&2
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

# 引数はジョブキューのレスポンス経由で渡るため、呼び出し元で検証済みでも改めて検証する
# （多層防御。ここが最後にパス・シェル引数として使う場所）。
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

warn_personal_config_drift
resolve_launcher_scripts_dir "$ROOT"
warn_launcher_scripts_stale "$ROOT"
if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
  echo "情報: セッション側のスクリプトは $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行します（#1438）。"
fi

# --- 参照するリポジトリ -------------------------------------------------------
# **申告と同じ関数を使う**（`local_repo_list_runnable`）。画面に出ている参照範囲の件数と、
# 実際に渡すディレクトリがずれないようにするため。1件も無ければ質問に答える材料が無いので、
# 起動せずに理由を出して止める（issue-deck側も`no_runnable_repositories`で断っている）。
REFERENCE_NAMES=()
REFERENCE_DIRS=()
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if ! repo_path="$(local_repo_resolve_path "$name")"; then
    continue
  fi
  [[ -d "$repo_path" ]] || continue
  REFERENCE_NAMES+=("$name")
  REFERENCE_DIRS+=("$repo_path")
done < <(local_repo_list_runnable)

if [[ "${#REFERENCE_DIRS[@]}" -eq 0 ]]; then
  echo "Error: 参照できるリポジトリが1つもありません（$(local_repos_config_file)）。" >&2
  echo "  cloneの有無と対応表の記載を確認してください。" >&2
  exit 1
fi

echo "#$ISSUE_NUMBER: 参照するリポジトリ: ${#REFERENCE_DIRS[@]}件"

# --- 作業ディレクトリ ---------------------------------------------------------
# **どのリポジトリでもない空のディレクトリをcwdにする。** 実装セッションのworktreeや
# リポジトリ本体をcwdにすると、そこだけが「主」になって横断の視点が偏るうえ、
# 他セッションが編集中の作業ツリーへ書き込む余地を残すことになる。
QUESTION_BASE="${ISSUE_DECK_QUESTION_BASE:-$HOME/apps/issue-deck-worktrees/.questions}"
SAFE_REPO="${REPO//[^A-Za-z0-9_-]/-}"
SESSION_DIR="$QUESTION_BASE/$SAFE_REPO-$ISSUE_NUMBER"
PROMPT_DIR="$QUESTION_BASE/.prompts"
PROMPT_FILE="$PROMPT_DIR/$SAFE_REPO-$ISSUE_NUMBER.md"
mkdir -p "$SESSION_DIR" "$PROMPT_DIR"

# --- 質問Issue ---------------------------------------------------------------
echo "#$ISSUE_NUMBER: 質問Issueを取得しています（$FULL_NAME）..."
if ! ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$FULL_NAME" \
  --json number,title,body,comments 2>/dev/null)"; then
  echo "Error: Issue #$ISSUE_NUMBER（$FULL_NAME）を取得できませんでした。" >&2
  exit 1
fi

PROMPT_TEMPLATE="$LAUNCHER_SCRIPTS_DIR/prompts/cross-repo-question-agent.md"
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: プロンプトのテンプレートがありません（$PROMPT_TEMPLATE）。" >&2
  exit 1
fi

# 参照リポジトリの一覧をプロンプトへ差し込む形（`- owner/repo … パス`）に整える。
REFERENCE_LIST=""
for i in "${!REFERENCE_NAMES[@]}"; do
  REFERENCE_LIST+="- \`${REFERENCE_NAMES[$i]}\` … \`${REFERENCE_DIRS[$i]}\`"$'\n'
done

echo "#$ISSUE_NUMBER: 起動用プロンプトを生成しています..."
ISSUE_JSON_FILE="$(mktemp)"
printf '%s' "$ISSUE_JSON" >"$ISSUE_JSON_FILE"
python3 - "$ISSUE_JSON_FILE" "$PROMPT_TEMPLATE" "$FULL_NAME" "$SESSION_DIR" "$REFERENCE_LIST" \
  >"$PROMPT_FILE" <<'PY'
import json
import sys

(
    issue_json_path,
    template_path,
    repository,
    session_dir,
    reference_list,
) = sys.argv[1:6]

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
    "{{REFERENCE_LIST}}": reference_list.rstrip("\n") or "(なし)",
    "{{REFERENCE_COUNT}}": str(len([l for l in reference_list.splitlines() if l.strip()])),
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
  local var value dir prefix="" dirs=""
  # 開発サーバーは起動しない（読み取り専用の質問セッションで、画面を見る用事が無い）
  prefix+="export ISSUE_DECK_DEV_SERVER=0; "
  prefix+="export ISSUE_DECK_WORKTREE_BASE=$(printf '%q' "$QUESTION_BASE"); "
  # cwdがgitリポジトリでないため、run-issue-session.sh は remote.origin.url から
  # リポジトリ名を取れない（#1454）。セッション名とセッション報告のために渡す
  prefix+="export ISSUE_DECK_REPO_SLUG=$(printf '%q' "$FULL_NAME"); "
  # 回収の条件を実装セッションと分ける印（#1454）。worktreeを持たないため、
  # 「worktreeがcleanでpush済み」の判定を当てると永久に残る
  prefix+="export ISSUE_DECK_SESSION_KIND=question; "
  # **書き込み系のツールを機械的に封じる。** `gh issue comment`で回答するためBashは残す
  prefix+="export ISSUE_DECK_DISALLOWED_TOOLS=$(printf '%q' "Edit,Write,NotebookEdit"); "
  for dir in "${REFERENCE_DIRS[@]}"; do
    dirs+="$dir"$'\n'
  done
  prefix+="export ISSUE_DECK_EXTRA_DIRS=$(printf '%q' "$dirs"); "
  for var in ISSUE_DECK_SHARED_CONTEXT_DIR ISSUE_DECK_CLAUDE_PERMISSION_MODE \
    ISSUE_DECK_SESSION_REAPABLE ISSUE_DECK_SESSION_STATE_DIR; do
    value="${!var:-}"
    [[ -n "$value" ]] || continue
    prefix+="export $var=$(printf '%q' "$value"); "
  done
  if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
    prefix+="export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA=$(printf '%q' "$LAUNCHER_SCRIPTS_SHA"); "
    prefix+="export ISSUE_DECK_LAUNCHER_ROOT=$(printf '%q' "$ROOT"); "
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

# 同名のセッションが動いていれば作らない（実装セッションと同じ扱い）。`remain-on-exit`で
# 残った「死んだペインだけのセッション」は前回の終了の痕跡なので、最後の出力を見せてから畳む。
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

echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」で横断質問セッションを起動します..."
if ! tmux new-session -d -s "$SESSION_NAME" -c "$SESSION_DIR" "bash -lc $(printf '%q' "$SESSION_CMD")"; then
  echo "Error: tmuxセッション「$SESSION_NAME」の起動に失敗しました。" >&2
  exit 1
fi

# 異常終了時にペインを残す（既定ではコマンドの終了と同時にセッションごと消え、エラーが残らない）。
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
