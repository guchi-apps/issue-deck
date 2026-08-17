#!/usr/bin/env bash
# 計画の関門（G1・#1218）のセッションを起こすランチャー（#1855）。
#
# 使い方:
#   scripts/start-plan-review.sh <owner> <repo> <issue番号>
#   scripts/start-plan-review.sh --prepare-only <owner> <repo> <issue番号>
#
# 呼び出し経路:
#   ローカルセッションが計画を投稿（ExitPlanMode のフック → POST /api/dispatch/sessions/plan）
#     → ジョブキュー（kind=PLAN_REVIEW）→ scripts/subpc-dispatch-poller.sh → このスクリプト
#   issue-deckの画面「計画をレビュー」からも同じジョブが積まれる。
#
# **人が叩く入口は scripts/start-reviewer.sh --plan の方**（本体チェックアウトで対話セッションを
# 起こす）。こちらは自動起動用で、次の3点が違う。
#
#   作業ディレクトリ  対象リポジトリの `origin/develop` のスナップショット（detachedのworktree）。
#                     **本体チェックアウトを占有しない** — 本体で `git checkout develop` すると、
#                     `gh pr checkout` で作業中のレビュー・統合セッション（G2）のブランチを奪う。
#                     未コミットの変更があるだけで起動できなくなる問題も避けられる。
#                     ついでに、参照するコードが古いままになる問題（#1583）も起きない
#   実行             `claude -p` を1回。**レビュー1本で終わり、セッションごと畳む。**
#                     人が付き添う前提が無いので対話セッションにしない
#   許可ツール        Actionsの計画レビューと同じ許可リスト（`gh pr merge`・`gh issue edit` を
#                     含めない）。承認まで倒せないこと・自己承認の構図にならないことを構造で担保する
#                     （docs/multi-agent/gates.md「G1が承認しない理由」）
#
# **フック（session-notify.sh）は付けない。** 実装セッション用の経路（run-issue-session.sh）へ
# 載せると、同じIssueに受付コメント（#1119）が二重に出るうえ、`Stop` フックが
# **このIssueの `00.check-user`（＝計画の承認待ち）を外してしまう**。G1は計画の承認待ちを
# 解く役ではない。
#
# セッション名は `<リポジトリ名>-plan-review-<番号>`。**実装セッションの `<リポジトリ名>-issue-<番号>`
# とは別の形にしてある** — pollerのセッション報告・本数の計上・停止/終了の突き合わせはすべて
# `-issue-` の規約に依存しており、そこへ混ざると「実装セッションのつもりで計画レビューを畳む」
# ことになる。
#
# 環境変数:
#   ISSUE_DECK_PLAN_REVIEW_BASE         プロンプト・ログの置き場（既定 ~/apps/issue-deck-worktrees/.plan-reviews）
#   ISSUE_DECK_QUESTION_BASE            参照スナップショットの置き場（横断質問と共有。#1583）
#   ISSUE_DECK_SHARED_CONTEXT_DIR       共有知識リポジトリ（既定は ~/apps/_docs）
#   ISSUE_DECK_LAUNCHER_REEXEC          1なら同期コピーからの再実行を行わない（内部用・#1583）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

# 同期コピーから自分自身を実行し直すとき（#1583）にそのまま渡す。
ORIGINAL_ARGS=(${@+"$@"})

# 対応表の解決・検証は受け口・pollerと共有する（判定を二重に持たない）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# 起動スクリプト自身が古いままの場合の警告と、同期コピーの解決（#1274・#1438・#1583）。
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$SCRIPT_DIR/lib/launcher-scripts-sync.sh"
# 参照先を`origin/develop`のスナップショットにする（#1583）。横断質問と同じ置き場を使う。
# shellcheck source=scripts/lib/question-refs.sh
source "$SCRIPT_DIR/lib/question-refs.sh"
# プロンプトの組み立て。**人の入口（start-reviewer.sh --plan）と共有する。**
# shellcheck source=scripts/lib/plan-review-prompt.sh
source "$SCRIPT_DIR/lib/plan-review-prompt.sh"
# フォルダの信頼確認（#1838）。未信頼のまま起こすとセッションが確認待ちで止まる。
# shellcheck source=scripts/lib/claude-trust.sh
source "$SCRIPT_DIR/lib/claude-trust.sh"

usage() {
  echo "Usage: scripts/start-plan-review.sh [--prepare-only] <owner> <repo> <issue番号>" >&2
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

for required_command in git python3; do
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

# **ランチャー自身も同期コピーから走らせる**（#1583）。pollerは本体の作業ツリーの`scripts/`を
# 直接起動するため、ここを通さないとランチャーの修正は誰かが本体を`git pull`するまで効かない。
if [[ -n "$LAUNCHER_SCRIPTS_SHA" && "${ISSUE_DECK_LAUNCHER_REEXEC:-0}" != "1" &&
  -f "$LAUNCHER_SCRIPTS_DIR/start-plan-review.sh" ]]; then
  echo "情報: ランチャー自身も $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行し直します（#1583）。"
  export ISSUE_DECK_LAUNCHER_REEXEC=1
  export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA="$LAUNCHER_SCRIPTS_SHA"
  export ISSUE_DECK_LAUNCHER_ROOT="$ROOT"
  exec bash "$LAUNCHER_SCRIPTS_DIR/start-plan-review.sh" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
fi

# 同期コピーから再実行された側では`LAUNCHER_SCRIPTS_SHA`が空になるため、引き継いだ値を見る。
LAUNCHER_SCRIPTS_SHA="${LAUNCHER_SCRIPTS_SHA:-${ISSUE_DECK_LAUNCHER_SCRIPTS_SHA:-}}"

# --- 対象リポジトリ -----------------------------------------------------------
# **計画レビューは対象リポジトリのコードを読む。** 横断質問（記録先のcloneが要らない）とは違い、
# cloneされていなければ何も突き合わせられないので、ここで理由を出して止める
# （issue-deck側も`repository_not_runnable`で断っている）。
if ! REPO_PATH="$(local_repo_resolve_path "$FULL_NAME")" || [[ ! -d "$REPO_PATH" ]]; then
  echo "Error: $FULL_NAME のチェックアウトが見つかりません（$(local_repos_config_file)）。" >&2
  exit 1
fi

# 未信頼のまま起こすと、tmuxの中でフォルダの信頼確認を出したまま止まる（#1465・#1838）。
# **信頼は本体チェックアウトのパスに記録される**ため、スナップショットのworktreeでも
# ここの判定がそのまま効く。
claude_trust_require "$REPO_PATH" "$FULL_NAME" || exit 1

# --- 参照するコード（origin/develop のスナップショット）------------------------
echo "#$ISSUE_NUMBER: $FULL_NAME を最新化しています..."
question_refs_fetch_all "$REPO_PATH"
question_ref_prepare "$FULL_NAME" "$REPO_PATH"
WORKDIR="$QUESTION_REF_DIR"
CHECKOUT_LABEL="$QUESTION_REF_LABEL"
if [[ "$QUESTION_REF_SNAPSHOT" -ne 1 ]]; then
  # スナップショットを用意できなかった場合は本体チェックアウトを読む（`question_ref_prepare`の
  # フォールバック）。**それでもレビューは行う** — 参照先が1つ古いことより、計画が誰にも
  # 検算されないことのほうが困る。どれくらい古いのかはプロンプトに載るので、指摘を読む側が
  # 割り引いて読める。
  echo "警告: スナップショットを用意できませんでした。本体チェックアウトを読みます（$CHECKOUT_LABEL）。" >&2
fi
echo "#$ISSUE_NUMBER: 読むコード: $WORKDIR（$CHECKOUT_LABEL）"

# --- プロンプト ---------------------------------------------------------------
# 対象リポジトリが自分のプロンプトを持っていればそれを使い、無ければissue-deckの汎用
# テンプレートを使う（実装セッションの`generic-start-issue.sh`と同じ解決順）。
PROMPT_TEMPLATE="$WORKDIR/scripts/prompts/plan-review-agent.md"
PROMPT_TEMPLATE_SOURCE="対象リポジトリ"
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  PROMPT_TEMPLATE="$LAUNCHER_SCRIPTS_DIR/prompts/generic-plan-review-agent.md"
  PROMPT_TEMPLATE_SOURCE="issue-deckの汎用テンプレート"
fi
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: プロンプトのテンプレートがありません（$PROMPT_TEMPLATE）。" >&2
  exit 1
fi

PLAN_REVIEW_BASE="${ISSUE_DECK_PLAN_REVIEW_BASE:-$HOME/apps/issue-deck-worktrees/.plan-reviews}"
SAFE_REPO="${REPO//[^A-Za-z0-9_-]/-}"
PROMPT_DIR="$PLAN_REVIEW_BASE/.prompts"
PROMPT_FILE="$PROMPT_DIR/$SAFE_REPO-$ISSUE_NUMBER.md"
LOG_FILE="$PLAN_REVIEW_BASE/$SAFE_REPO-$ISSUE_NUMBER.log"
mkdir -p "$PROMPT_DIR"

# 並行状況スナップショット（#1215）。**突き合わせるのは本体チェックアウト**（スナップショットは
# detachedで、未マージPRやブランチの分岐を見るための情報を持たない）。
FLEET_STATUS_FILE="$(mktemp)"
trap 'rm -f "${FLEET_STATUS_FILE:-}"' EXIT
plan_review_fleet_status "$LAUNCHER_SCRIPTS_DIR/fleet-status.sh" "$REPO_PATH" "$FULL_NAME" \
  >"$FLEET_STATUS_FILE"

echo "#$ISSUE_NUMBER: 起動用プロンプトを生成しています（$PROMPT_TEMPLATE_SOURCE）..."
plan_review_render_prompt "$PROMPT_TEMPLATE" "$ISSUE_NUMBER" "$FULL_NAME" "$WORKDIR" \
  "$CHECKOUT_LABEL" "$FLEET_STATUS_FILE" >"$PROMPT_FILE"

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  echo "#$ISSUE_NUMBER: 準備が完了しました。"
  echo "  作業ディレクトリ: $WORKDIR（$CHECKOUT_LABEL）"
  echo "  プロンプト: $PROMPT_FILE"
  exit 0
fi

# --- セッションの起動 ---------------------------------------------------------
SESSION_NAME="$SAFE_REPO-plan-review-$ISSUE_NUMBER"

# **許可するツールはActionsの計画レビュー（reusable-issue-dispatch.ymlの「Claude Code（計画レビュー）」）
# と同じ。** 文面（プロンプト）だけでなく、できることの範囲も2つの入口で揃える。
# `gh pr merge`・`gh pr edit`（G2との兼務＝自己承認）と`gh issue edit`（承認まで倒す）は入れない。
PLAN_REVIEW_ALLOWED_TOOLS='Bash(gh issue view:*),Bash(gh issue comment:*),Bash(gh pr list:*),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh api:*),Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git ls-remote:*),Bash(grep:*),Bash(find:*),Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Read,Grep,Glob'
# サブエージェントは使わせない（Actions側と同じ）。指摘の根拠は自分で確かめたものに限る。
PLAN_REVIEW_DISALLOWED_TOOLS='Task,Agent'

CLAUDE_ARGS=(-p --allowedTools "$PLAN_REVIEW_ALLOWED_TOOLS" --disallowedTools "$PLAN_REVIEW_DISALLOWED_TOOLS")

# 共有知識リポジトリ（guchi-apps/docs）をcloneしてある場合だけ参照させる。
SHARED_CONTEXT_DIR="${ISSUE_DECK_SHARED_CONTEXT_DIR:-$HOME/apps/_docs}"
if [[ -d "$SHARED_CONTEXT_DIR" ]]; then
  CLAUDE_ARGS+=(--add-dir "$SHARED_CONTEXT_DIR")
fi

# tmuxのセッションはtmuxサーバー側の環境を引き継ぐため、値は%qでクォートして埋める。
#
# **プロンプトは引数ではなく標準入力から渡す。** `--add-dir`は複数のディレクトリを取れる
# 可変長の引数で、後ろに置いた位置引数（プロンプト）まで飲み込む。実際にそれで
# `Input must be provided either through stdin or as a prompt argument when using --print`
# で落ちた。標準入力なら、フラグの並びが変わっても影響を受けない。
#
# **出力はログへも落とす。** `claude -p`は終わるとペインごと消えるので、残しておかないと
# 「指摘が投稿されなかったのはなぜか」を後から辿れない。
# `set -o pipefail` を先に置く。**`| tee` を挟むと終了コードが`tee`のものになり**、
# `remain-on-exit failed`（失敗したときだけペインを残す）が永久に効かなくなる。
SESSION_CMD="$(printf 'set -o pipefail; cd %q && cat %q | claude' "$WORKDIR" "$PROMPT_FILE")"
for arg in "${CLAUDE_ARGS[@]}"; do
  SESSION_CMD+=" $(printf '%q' "$arg")"
done
SESSION_CMD+=" 2>&1 | tee $(printf '%q' "$LOG_FILE")"

if ! command -v tmux >/dev/null 2>&1; then
  echo "警告: tmux が見つからないため、このターミナルで実行します。" >&2
  exec bash -lc "$SESSION_CMD"
fi

# 同名のセッションが動いていれば作らない（実装セッションと同じ扱い）。`remain-on-exit`で
# 残った「死んだペインだけのセッション」は前回の失敗の痕跡なので、最後の出力を見せてから畳む。
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

echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」で計画レビュー（G1）を起動します..."
if ! tmux new-session -d -s "$SESSION_NAME" -c "$WORKDIR" "bash -lc $(printf '%q' "$SESSION_CMD")"; then
  echo "Error: tmuxセッション「$SESSION_NAME」の起動に失敗しました。" >&2
  exit 1
fi

# 異常終了時だけペインを残す。**正常に終わったらセッションごと消える**のが期待する動きで、
# 残るのは失敗したときの手掛かりとして読むため。
tmux set-option -t "$SESSION_NAME:" -w remain-on-exit failed >/dev/null 2>&1 ||
  tmux set-option -t "$SESSION_NAME:" -w remain-on-exit on >/dev/null 2>&1 || true

echo
echo "  様子を見る: tmux attach -t $SESSION_NAME"
echo "  ログ: $LOG_FILE"
