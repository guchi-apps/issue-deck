#!/usr/bin/env bash
# リポジトリ全体のコードレビューを走らせるランチャー（#698）。
#
# 使い方:
#   scripts/start-code-review.sh <owner> <repo> <issue番号>
#   scripts/start-code-review.sh --prepare-only <owner> <repo> <issue番号>
#
# 呼び出し経路:
#   issue-deckの画面「コードレビューを実行」
#     → レビューIssueを1件作成 → ジョブキュー（kind=CODE_REVIEW）
#     → scripts/subpc-dispatch-poller.sh → このスクリプト
#
# **作りは計画レビュー（scripts/start-plan-review.sh）とほぼ同じ。** 違うのは3点だけ。
#
#   読む範囲   計画と実装の突き合わせではなく、**リポジトリ全体**
#   出力       指摘を所定の書式でレビューIssueへ1件のコメントとして投稿する
#              （画面がその書式を読んで指摘カードにする）
#   起動       人が画面から押したときだけ。自動で積まれる経路は無い
#
# **同じ形なのに1本にまとめないのは、許可するツールと文面が別物だから。** 共有しているのは
# 参照スナップショットの作り方（question-refs.sh）で、そこは実際に共有している。
#
# **フック（session-notify.sh）は付けない**（計画レビューと同じ理由）。実装セッション用の経路へ
# 載せると、同じIssueに受付・締めのコメントが二重に出る。代償として通知にも自動回収にも
# 乗らないため、**実行時間の上限を必ず被せる。**
#
# セッション名は `<リポジトリ名>-code-review-<番号>`。**実装セッションの `<リポジトリ名>-issue-<番号>`
# とは別の形にしてある**（pollerのセッション報告・本数の計上・停止/終了の突き合わせはすべて
# `-issue-` の規約に依存しているため）。
#
# 環境変数:
#   ISSUE_DECK_CODE_REVIEW_BASE         プロンプト・ログ・参照スナップショットの置き場
#                                       （既定 ~/apps/issue-deck-worktrees/.code-reviews）
#   ISSUE_DECK_CODE_REVIEW_TIMEOUT_SECONDS
#                                       1本のレビューに被せる上限秒数（既定2700・0で無効）
#   ISSUE_DECK_SHARED_CONTEXT_DIR       共有知識リポジトリ（既定は ~/apps/_docs）
#   ISSUE_DECK_LAUNCHER_REEXEC          1なら同期コピーからの再実行を行わない（内部用・#1583）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

# 同期コピーから自分自身を実行し直すとき（#1583）にそのまま渡す。
ORIGINAL_ARGS=(${@+"$@"})

# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$SCRIPT_DIR/lib/launcher-scripts-sync.sh"
# 参照先を`origin/develop`のスナップショットにする（#1583）。仕組みは横断質問・計画レビューと
# 共有するが、**置き場は分ける**（下の`ISSUE_DECK_QUESTION_BASE`の上書き）。
# shellcheck source=scripts/lib/question-refs.sh
source "$SCRIPT_DIR/lib/question-refs.sh"
# フォルダの信頼確認（#1838）。未信頼のまま起こすとセッションが確認待ちで止まる。
# shellcheck source=scripts/lib/claude-trust.sh
source "$SCRIPT_DIR/lib/claude-trust.sh"
# APIの一時的な過負荷（529）で打ち切られにくくする（#1971）。
# shellcheck source=scripts/lib/claude-retries.sh
source "$SCRIPT_DIR/lib/claude-retries.sh"

usage() {
  echo "Usage: scripts/start-code-review.sh [--prepare-only] <owner> <repo> <issue番号>" >&2
}

# 走っているコードレビューのセッション名（`<リポジトリ名>-code-review-<番号>`）。
# **`report_sessions`も`count_issue_sessions`もこの名前を拾わない**ので、本数を知る手掛かりは
# ここしか無い。pollerの同名の判定（`count_code_review_sessions`）と規約を揃える。
code_review_session_names() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null |
    grep -E '^.+-code-review-[1-9][0-9]*$' || true
}

# 同じリポジトリのコードレビューが（このIssue以外も含めて）走っているか。
code_review_sessions_alive_for() {
  local safe_repo="$1"
  code_review_session_names | grep -qE "^${safe_repo}-code-review-[1-9][0-9]*$"
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

CODE_REVIEW_BASE="${ISSUE_DECK_CODE_REVIEW_BASE:-$HOME/apps/issue-deck-worktrees/.code-reviews}"
SAFE_REPO="${REPO//[^A-Za-z0-9_-]/-}"
SESSION_NAME="$SAFE_REPO-code-review-$ISSUE_NUMBER"
PROMPT_DIR="$CODE_REVIEW_BASE/.prompts"
PROMPT_FILE="$PROMPT_DIR/$SAFE_REPO-$ISSUE_NUMBER.md"
LOG_FILE="$CODE_REVIEW_BASE/$SAFE_REPO-$ISSUE_NUMBER.log"

# 引数はジョブキューのレスポンス経由で渡るため、呼び出し元で検証済みでも改めて検証する
# （多層防御。ここが最後にパス・シェル引数として使う場所）。
local_session_validate_target "$OWNER" "$REPO" "$ISSUE_NUMBER" || exit 1

for required_command in git gh python3; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done
if [[ "$PREPARE_ONLY" -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude コマンドが見つかりません。" >&2
  exit 1
fi

resolve_launcher_scripts_dir "$ROOT"
warn_launcher_scripts_stale "$ROOT"

# **ランチャー自身も同期コピーから走らせる**（#1583）。
if [[ -n "$LAUNCHER_SCRIPTS_SHA" && "${ISSUE_DECK_LAUNCHER_REEXEC:-0}" != "1" &&
  -f "$LAUNCHER_SCRIPTS_DIR/start-code-review.sh" ]]; then
  echo "情報: ランチャー自身も $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行し直します（#1583）。"
  export ISSUE_DECK_LAUNCHER_REEXEC=1
  export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA="$LAUNCHER_SCRIPTS_SHA"
  export ISSUE_DECK_LAUNCHER_ROOT="$ROOT"
  exec bash "$LAUNCHER_SCRIPTS_DIR/start-code-review.sh" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
fi

LAUNCHER_SCRIPTS_SHA="${LAUNCHER_SCRIPTS_SHA:-${ISSUE_DECK_LAUNCHER_SCRIPTS_SHA:-}}"

# --- 対象リポジトリ -----------------------------------------------------------
# **レビューは対象リポジトリのコードそのものが主題。** cloneされていなければ読むものが無いので、
# ここで理由を出して止める（issue-deck側も`repository_not_runnable`で断っている）。
if ! REPO_PATH="$(local_repo_resolve_path "$FULL_NAME")" || [[ ! -d "$REPO_PATH" ]]; then
  echo "Error: $FULL_NAME のチェックアウトが見つかりません（$(local_repos_config_file)）。" >&2
  exit 1
fi

claude_trust_require "$REPO_PATH" "$FULL_NAME" || exit 1

# --- 参照するコード（origin/develop のスナップショット）------------------------
#
# **置き場は横断質問・計画レビューと分ける。** あちらのスナップショットは起動のたびに
# `checkout --force --detach`で別のコミットへ貼り替えられる。リポジトリ全体を読んでいる最中に
# 足元のコードが変わると、指摘のファイル:行がその場でずれる。置き場を分ければ、貼り替える
# 可能性があるのは同じリポジトリの別のレビューだけになり、その1点は下のガードで塞げる。
export ISSUE_DECK_QUESTION_BASE="$CODE_REVIEW_BASE"

echo "#$ISSUE_NUMBER: $FULL_NAME を最新化しています..."
question_refs_fetch_all "$REPO_PATH"

SNAPSHOT_DIR="$(question_refs_base_dir)/$(question_refs_safe_name "$FULL_NAME")"
if [[ -d "$SNAPSHOT_DIR" ]] && code_review_sessions_alive_for "$SAFE_REPO"; then
  WORKDIR="$SNAPSHOT_DIR"
  CHECKOUT_LABEL="$(git -C "$SNAPSHOT_DIR" log -1 --format='%h・%cs' 2>/dev/null || printf '不明')（別のコードレビューが読んでいるため貼り替えていません）"
else
  question_ref_prepare "$FULL_NAME" "$REPO_PATH"
  WORKDIR="$QUESTION_REF_DIR"
  CHECKOUT_LABEL="$QUESTION_REF_LABEL"
  if [[ "$QUESTION_REF_SNAPSHOT" -ne 1 ]]; then
    # スナップショットを用意できなかった場合は本体チェックアウトを読む。**それでもレビューは
    # 行う** — 参照先が1つ古いことより、レビューが1本も出ないことのほうが困る。どれくらい
    # 古いのかはプロンプトに載るので、指摘を読む側が割り引いて読める。
    echo "警告: スナップショットを用意できませんでした。本体チェックアウトを読みます（$CHECKOUT_LABEL）。" >&2
  fi
fi
echo "#$ISSUE_NUMBER: 読むコード: $WORKDIR（$CHECKOUT_LABEL）"

# --- レビューIssue -------------------------------------------------------------
# 観点（`## 重点的に見る観点`）は本文に書いてあるので、そのままプロンプトへ差し込む。
echo "#$ISSUE_NUMBER: レビューIssueを取得しています（$FULL_NAME）..."
if ! ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$FULL_NAME" \
  --json number,title,body 2>/dev/null)"; then
  echo "Error: Issue #$ISSUE_NUMBER（$FULL_NAME）を取得できませんでした。" >&2
  exit 1
fi

# --- プロンプト ---------------------------------------------------------------
# 対象リポジトリが自分のプロンプトを持っていればそれを使い、無ければissue-deckのテンプレート
# （実装セッション・計画レビューと同じ解決順）。
PROMPT_TEMPLATE="$WORKDIR/scripts/prompts/code-review-agent.md"
PROMPT_TEMPLATE_SOURCE="対象リポジトリ"
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  PROMPT_TEMPLATE="$LAUNCHER_SCRIPTS_DIR/prompts/code-review-agent.md"
  PROMPT_TEMPLATE_SOURCE="issue-deckのテンプレート"
fi
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: プロンプトのテンプレートがありません（$PROMPT_TEMPLATE）。" >&2
  exit 1
fi

mkdir -p "$PROMPT_DIR"

echo "#$ISSUE_NUMBER: 起動用プロンプトを生成しています（$PROMPT_TEMPLATE_SOURCE）..."
ISSUE_JSON_FILE="$(mktemp)"
trap 'rm -f "${ISSUE_JSON_FILE:-}"' EXIT
printf '%s' "$ISSUE_JSON" >"$ISSUE_JSON_FILE"
python3 - "$ISSUE_JSON_FILE" "$PROMPT_TEMPLATE" "$FULL_NAME" "$WORKDIR" "$CHECKOUT_LABEL" \
  >"$PROMPT_FILE" <<'PY'
import json
import sys

issue_json_path, template_path, repository, workdir, checkout = sys.argv[1:6]

with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

replacements = {
    "{{ISSUE_NUMBER}}": str(issue["number"]),
    "{{ISSUE_TITLE}}": issue["title"],
    "{{ISSUE_BODY}}": issue.get("body") or "(本文なし)",
    "{{REPOSITORY}}": repository,
    "{{WORKDIR}}": workdir,
    "{{CHECKOUT}}": checkout,
}
result = template
for placeholder, value in replacements.items():
    result = result.replace(placeholder, value)
sys.stdout.write(result)
PY

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  echo "#$ISSUE_NUMBER: 準備が完了しました。"
  echo "  作業ディレクトリ: $WORKDIR（$CHECKOUT_LABEL）"
  echo "  プロンプト: $PROMPT_FILE"
  exit 0
fi

# --- セッションの起動 ---------------------------------------------------------
# **書けるのはレビューIssueへのコメントだけ。** `gh issue create`は入れない（指摘をIssueに
# するかどうかは、画面で読んだ人が決める。数十件のIssueが自動で立つと盤面のほうが壊れる）。
# `gh issue edit`・`gh pr *`の書き込みも入れない。
CODE_REVIEW_ALLOWED_TOOLS='Bash(gh issue view:*),Bash(gh issue comment:*),Bash(gh api:*),Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git ls-files:*),Bash(grep:*),Bash(rg:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Read,Grep,Glob'
# サブエージェントは使わせない（計画レビューと同じ）。指摘の根拠は自分で読んだものに限る。
CODE_REVIEW_DISALLOWED_TOOLS='Task,Agent'

CLAUDE_ARGS=(-p --allowedTools "$CODE_REVIEW_ALLOWED_TOOLS" --disallowedTools "$CODE_REVIEW_DISALLOWED_TOOLS")

SHARED_CONTEXT_DIR="${ISSUE_DECK_SHARED_CONTEXT_DIR:-$HOME/apps/_docs}"
if [[ -d "$SHARED_CONTEXT_DIR" ]]; then
  CLAUDE_ARGS+=(--add-dir "$SHARED_CONTEXT_DIR")
fi

# **プロンプトは標準入力から渡す**（`--add-dir`が可変長で位置引数を飲み込むため。計画レビューと同じ）。
# **出力はログへも落とす**（`claude -p`は終わるとペインごと消えるため）。
# **実行時間の上限を必ず被せる。** リポジトリ全体を読ませるぶん計画レビューより長く、
# 固まっても誰も気づけない（通知にも自動回収にも乗らない）。既定は45分。
CODE_REVIEW_TIMEOUT="${ISSUE_DECK_CODE_REVIEW_TIMEOUT_SECONDS:-2700}"
RUNNER=""
if [[ "$CODE_REVIEW_TIMEOUT" =~ ^[0-9]+$ && "$CODE_REVIEW_TIMEOUT" -gt 0 ]] &&
  command -v timeout >/dev/null 2>&1; then
  RUNNER="timeout $CODE_REVIEW_TIMEOUT "
fi

claude_export_max_retries
SESSION_CMD="$(printf 'set -o pipefail; cd %q && cat %q | CLAUDE_CODE_MAX_RETRIES=%q %sclaude' \
  "$WORKDIR" "$PROMPT_FILE" "$CLAUDE_CODE_MAX_RETRIES" "$RUNNER")"
for arg in "${CLAUDE_ARGS[@]}"; do
  SESSION_CMD+=" $(printf '%q' "$arg")"
done
SESSION_CMD+=" 2>&1 | tee $(printf '%q' "$LOG_FILE")"

if ! command -v tmux >/dev/null 2>&1; then
  echo "警告: tmux が見つからないため、このターミナルで実行します。" >&2
  exec bash -lc "$SESSION_CMD"
fi

# 同名のセッションが動いていれば作らない（実装セッション・計画レビューと同じ扱い）。
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

echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」でコードレビューを起動します..."
if ! tmux new-session -d -s "$SESSION_NAME" -c "$WORKDIR" "bash -lc $(printf '%q' "$SESSION_CMD")"; then
  echo "Error: tmuxセッション「$SESSION_NAME」の起動に失敗しました。" >&2
  exit 1
fi

# 異常終了時だけペインを残す（計画レビューと同じ）。
tmux set-option -t "$SESSION_NAME:" -w remain-on-exit failed >/dev/null 2>&1 ||
  tmux set-option -t "$SESSION_NAME:" -w remain-on-exit on >/dev/null 2>&1 || true

echo
echo "  様子を見る: tmux attach -t $SESSION_NAME"
echo "  ログ: $LOG_FILE"
