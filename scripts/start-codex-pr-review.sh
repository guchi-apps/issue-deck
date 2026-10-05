#!/usr/bin/env bash
# ChatGPTサブスクリプションで認証済みのCodex CLIを、develop向けPRの差分レビューに使う。
#
# 呼ぶのはサブPCのpoller。issue-deckのDispatchJob（`PR_REVIEW`・#3990）を取ったpollerが、tmuxの中で
# `--run`を起動する。**状態の正本はDispatchJob**で、このスクリプトが開始・生存報告・結果を報告する
# （`lib/pr-review-report.sh`）。GitHubへ残す判定印（`issue-deck-codex-review-verdict`）は、人が
# 読む結果の記録と、リリースPRの集計・画面のparserとの互換のためで、ジョブキューとしては使わない。
# かつての`--sweep`（全リポジトリのopen PRを巡回して要求印を拾う）は廃止した。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/agent-cli.sh
source "$SCRIPT_DIR/lib/agent-cli.sh"
# shellcheck source=scripts/lib/session-usage.sh
source "$SCRIPT_DIR/lib/session-usage.sh"
# shellcheck source=scripts/lib/review-usage.sh
source "$SCRIPT_DIR/lib/review-usage.sh"
# shellcheck source=scripts/lib/pr-review-report.sh
source "$SCRIPT_DIR/lib/pr-review-report.sh"

VERDICT_PREFIX='issue-deck-codex-review-verdict:'
SOURCE_MARKER='<!-- issue-deck-source:codex-review-develop -->'
TIMEOUT_SECONDS="${ISSUE_DECK_CODEX_PR_REVIEW_TIMEOUT_SECONDS:-1800}"
WORK_ROOT="${ISSUE_DECK_CODEX_PR_REVIEW_ROOT:-${TMPDIR:-/tmp}/issue-deck-codex-pr-reviews}"

usage() {
  echo "Usage: scripts/start-codex-pr-review.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> [<ジョブID>]" >&2
  echo "       scripts/start-codex-pr-review.sh --usage-flush <owner> <repo>" >&2
}

session_name_for() {
  local repo="$1" pr_number="$2" head_sha="$3"
  printf '%s' "${repo//[^A-Za-z0-9_-]/-}-codex-pr-review-${pr_number}-${head_sha:0:12}"
}

# ジョブへ報告済みか。**どの経路で終わっても、最後に1回だけ終了を報告する**（EXITトラップが
# 未報告なら「起動前の失敗」として報告する）。起動前に落ちても、30分待たずに原因が分かる（#3990）。
JOB_ID=""
JOB_REPORTED=0
JOB_FAILURE_NOTE="レビューの準備中に失敗しました"
TMUX_SESSION_NAME=""

report_finish() {
  local status="$1" message="$2" verdict="${3:-}"
  [[ "$JOB_REPORTED" -eq 0 ]] || return 0
  JOB_REPORTED=1
  pr_review_heartbeat_stop
  pr_review_report "$JOB_ID" "$status" "$message" "$verdict"
}

on_exit() {
  local code=$?
  if ((code != 0)); then
    report_finish failed "${JOB_FAILURE_NOTE}（終了コード ${code}）。サブPCの実行ログ（tmuxセッション ${TMUX_SESSION_NAME:-不明}）を確認してください。"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: $1 コマンドが見つかりません。" >&2
    exit 1
  }
}

cleanup_review_worktree() {
  git -C "$1" worktree remove --force "$2" >/dev/null 2>&1 || rm -rf "$2"
}

run_review() {
  local owner="$1" repo="$2" pr_number="$3" base_sha="$4" head_sha="$5"
  JOB_ID="${6:-}"
  TMUX_SESSION_NAME="$(session_name_for "$repo" "$pr_number" "$head_sha")"
  trap on_exit EXIT
  local full_name="$owner/$repo" local_path workdir prompt_file output_file log_file
  local verdict_pattern codex_command cleanup_command codex_model reasoning_effort
  local events_file started_at ended_at exit_code run_status usage_summary resolved_model
  local issue_number head_ref comment_url comment_status

  require_command gh
  require_command git
  require_command timeout
  codex_command="$(agent_cli_codex_command)"
  require_command "$codex_command"
  # pollerが渡すAPP_BASE_URLから、PRレビュー専用の設定を読む。取得できない環境では従来どおり
  # Codex CLIの既定を使うため、ローカル単体実行や一時的なIssueDeck停止でレビューを止めない。
  codex_model=auto
  reasoning_effort=default
  if [[ -n "${APP_BASE_URL:-}" ]]; then
    local settings_json
    settings_json="$(curl -fsS --max-time 5 "${APP_BASE_URL%/}/api/settings/claude-model" 2>/dev/null || true)"
    if [[ -n "$settings_json" ]]; then
      codex_model="$(jq -r '.workflowCodexModel // "auto"' <<<"$settings_json" 2>/dev/null || printf 'auto')"
      reasoning_effort="$(jq -r '.workflowCodexReasoningEffort // "default"' <<<"$settings_json" 2>/dev/null || printf 'default')"
    fi
  fi
  case "$codex_model" in auto|gpt-6-astra|gpt-6-sol|gpt-5.6-terra|gpt-6-luna|gpt-5.5|gpt-5.4) ;; *) codex_model=auto ;; esac
  case "$reasoning_effort" in default|low|medium|high|xhigh) ;; *) reasoning_effort=default ;; esac
  [[ -f "$SCRIPT_DIR/prompts/codex-pr-review-agent.md" ]] || {
    echo "Error: Codex PRレビュー用プロンプトがありません。" >&2
    exit 1
  }
  JOB_FAILURE_NOTE="レビューの準備に失敗しました（clone・設定・コマンド）"
  local_path="$(local_repo_resolve_path "$full_name")"
  mkdir -p "$WORK_ROOT"
  workdir="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}"
  prompt_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.md"
  output_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.out"
  log_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.log"
  events_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.events.jsonl"
  verdict_pattern="${VERDICT_PREFIX}(lgtm|needs-check|changes-requested) sha=${head_sha}"

  # EXITトラップはrun_review終了後に動くため、local変数の値をここで固定する。
  # 終了の報告（`on_exit`）も同じトラップで行う（トラップは1つしか持てない）。
  printf -v cleanup_command 'cleanup_review_worktree %q %q' "$local_path" "$workdir"
  trap "on_exit; $cleanup_command" EXIT
  JOB_FAILURE_NOTE="PRのコードの取得・レビュー用worktreeの作成に失敗しました"

  rm -rf "$workdir"
  # SHAそのもののfetchを許さないホストもあるため、GitHubが公開しているPR refとdevelopを取る。
  # 取得後にhead SHAをworktreeへ指定することで、要求時点と異なる追いコミットは読まない。
  git -C "$local_path" fetch --quiet origin develop "refs/pull/${pr_number}/head"
  git -C "$local_path" worktree add --detach "$workdir" "$head_sha" >/dev/null
  sed \
    -e "s|{{REPOSITORY}}|$full_name|g" \
    -e "s|{{PR_NUMBER}}|$pr_number|g" \
    -e "s|{{BASE_SHA}}|$base_sha|g" \
    -e "s|{{HEAD_SHA}}|$head_sha|g" \
    "$SCRIPT_DIR/prompts/codex-pr-review-agent.md" >"$prompt_file"

  local -a codex_model_args=()
  [[ "$codex_model" = auto ]] || codex_model_args=(-m "$codex_model")
  [[ "$reasoning_effort" = default ]] || codex_model_args+=(--config "model_reasoning_effort=$reasoning_effort")
  # `--json`でイベントを標準出力へ出させ、`turn.completed`のusageを使用量の報告に使う（#3995）。
  # `--ephemeral`では転記が残らないため、これが唯一の計測の手がかり。イベントには会話の本文も
  # 含まれるので、数値だけを取り出したら消す（下の`rm -f "$events_file"`）。
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # 画面で「どのモデルで走っているか」を読めるよう、実行中の報告へモデル名を添える（#3990）
  resolved_model="$(review_usage_codex_model "$codex_model")"
  PR_REVIEW_RUNNING_MESSAGE="Codexでレビューを実行中です（モデル: ${resolved_model:-既定}）"
  pr_review_report "$JOB_ID" running "$PR_REVIEW_RUNNING_MESSAGE"
  pr_review_heartbeat_start "$JOB_ID"
  JOB_FAILURE_NOTE="Codexの実行後の処理に失敗しました"
  exit_code=0
  timeout "$TIMEOUT_SECONDS" "$codex_command" exec --json --sandbox read-only --ephemeral "${codex_model_args[@]}" \
    --output-last-message "$output_file" -C "$workdir" <"$prompt_file" >"$events_file" 2>"$log_file" || exit_code=$?
  pr_review_heartbeat_stop
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$exit_code" in
    0) run_status=completed ;;
    124) run_status=timeout ;;
    *) run_status=failed ;;
  esac
  ((exit_code == 0)) || : >"$output_file"
  resolved_model="$(review_usage_codex_model "$codex_model")"
  usage_summary="$(codex_exec_usage_summary "$resolved_model" <"$events_file" 2>/dev/null || true)"
  rm -f "$events_file"
  local verdict="" failure_message=""
  if ! grep -qE "$verdict_pattern" "$output_file" 2>/dev/null; then
    case "$run_status" in
      timeout) failure_message="Codexが${TIMEOUT_SECONDS}秒以内に終わらなかったためタイムアウトしました。" ;;
      failed) failure_message="Codex CLIが失敗しました（終了コード ${exit_code}）。" ;;
      *) failure_message="Codexの出力から有効な判定（lgtm / needs-check / changes-requested）を読み取れませんでした。" ;;
    esac
    cat >"$output_file" <<EOF
⚠️ Codexによるレビューを完了できなかったか、有効な判定を取得できませんでした。サブPCの実行ログを確認してください。

<!-- issue-deck-codex-review-verdict:failed sha=$head_sha -->
$SOURCE_MARKER
EOF
  else
    verdict="$(grep -oE "${VERDICT_PREFIX}(lgtm|needs-check|changes-requested) sha=${head_sha}" "$output_file" | tail -n 1 |
      sed -E "s/^${VERDICT_PREFIX}([a-z-]+) sha=.*$/\1/")"
    printf '\n%s\n' "$SOURCE_MARKER" >>"$output_file"
  fi
  comment_status=0
  comment_url="$(gh pr comment "$pr_number" --repo "$full_name" --body-file "$output_file")" || comment_status=$?
  [[ -n "$comment_url" ]] && printf '%s\n' "$comment_url"

  # ジョブへ結果を報告する（#3990）。**GitHubへ結果を記録できなかったときは成功にしない**
  # ——人がGitHubだけを見ても結果を読める状態を保つため、記録の失敗は状態として明示する。
  # 使用量の報告より先に行い、報告の失敗でレビューの結果を変えない。
  if [[ -n "$failure_message" ]]; then
    report_finish failed "$failure_message"
  elif ((comment_status != 0)); then
    report_finish failed "判定は ${verdict} でしたが、GitHubへレビュー結果を記録できませんでした。"
  else
    report_finish succeeded "Codexレビューが完了しました（${verdict}）" "$verdict"
  fi

  # 使用量の報告（#3995）。**判定の投稿より後に回し、失敗してもレビューの結果を変えない。**
  # 対象Issueはブランチ名`issue-<番号>`から解決する（取れなければPR番号だけで残る）。
  head_ref="$(gh api "repos/${full_name}/pulls/${pr_number}" --jq '.head.ref' 2>/dev/null || true)"
  issue_number=""
  [[ "$head_ref" =~ ^issue-([1-9][0-9]*)$ ]] && issue_number="${BASH_REMATCH[1]}"
  [[ "$comment_url" =~ ^https:// ]] || comment_url=""
  review_usage_record codex codex-pr-review "$full_name" "$pr_number" "$head_sha" "$issue_number" \
    "$run_status" "$started_at" "$ended_at" "$resolved_model" "$comment_url" "$usage_summary"
  review_usage_flush
  return "$comment_status"
}

# 使用量の報告（#3995）の補完と送り直しだけを行う。pollerが巡回のたびに呼ぶ。
# 報告を入れる前の実行を「使用量の記録なし」として補完し、前回までに送れなかった報告
# （本番の不通・未デプロイの間に溜まったもの）をあわせて送り直す。GitHubには触れない。
usage_flush() {
  local owner="$1" repo="$2"
  mkdir -p "$WORK_ROOT"
  review_usage_backfill_logs "$WORK_ROOT" "$owner" "$repo"
  review_usage_flush
}

case "${1:-}" in
  --usage-flush)
    [[ $# -eq 3 ]] || { usage; exit 2; }
    usage_flush "$2" "$3"
    ;;
  --run)
    [[ $# -eq 6 || $# -eq 7 ]] || { usage; exit 2; }
    run_review "$2" "$3" "$4" "$5" "$6" "${7:-}"
    ;;
  *)
    usage
    exit 2
    ;;
esac
