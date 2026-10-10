#!/usr/bin/env bash
# リリースPR（base=main・head=release-main/v*）の差分全体のAIレビュー（#4238・#4212）。
#
# 呼ぶのはサブPCのpoller。DispatchJob（`RELEASE_REVIEW`）を取ったpollerが、tmuxの中で起動する。
# `base...head`の差分全体を読み取り専用のAI（担当はサーバー設定で決まり、`claude`か`codex`）へ渡し、
# 指摘・影響PR・影響ファイルを`/api/dispatch/report`の`releaseReview`として報告する。
#
#   scripts/run-release-review.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <agent> <claudeモデル> <codexモデル>
#
# **差分が大きいときは予算の範囲だけを渡し、確認できなかったファイル数を`totalFiles`・`reviewedFiles`で
# 報告する**（AIの自己申告に任せない）。サーバーは足りなければ「未確認範囲あり」として準備完了にしない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/review-usage.sh
source "$SCRIPT_DIR/lib/review-usage.sh"
# shellcheck source=scripts/lib/release-progress.sh
source "$SCRIPT_DIR/lib/release-progress.sh"
# shellcheck source=scripts/lib/agent-cli.sh
source "$SCRIPT_DIR/lib/agent-cli.sh"

WORK_ROOT="${ISSUE_DECK_RELEASE_REVIEW_ROOT:-${TMPDIR:-/tmp}/issue-deck-release-review}"
TIMEOUT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_TIMEOUT_SECONDS:-1800}"
HEARTBEAT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_HEARTBEAT_SECONDS:-60}"
# プロンプトへ入れる差分の上限（バイト）。超えた分のファイルは「未確認」として報告する
DIFF_BUDGET_BYTES="${ISSUE_DECK_RELEASE_REVIEW_DIFF_BUDGET_BYTES:-300000}"

JOB_ID=""
JOB_REPORTED=0
RUNNING_MESSAGE="全体レビューを準備しています"
HEARTBEAT_PID=""
WORKTREE=""
LOCAL_PATH=""
ERR_FILE=""

# 実行失敗の診断（#4300）。**コードへの指摘ではなく「レビューを最後まで行えなかった理由」**で、
# 画面に出す。原因は観測できた事実だけで決め、決められなければ unknown（原因未特定）にする。
# 抜粋は末尾だけ・機密を伏せる（サーバー側でも同じ除去を通す。ここは外へ出す前の一次防御）。
diag_redact() {
  sed -E \
    -e 's/(Bearer|Basic)[[:space:]]+[A-Za-z0-9._~+\/=-]{8,}/\1 [除去]/Ig' \
    -e 's#op://[^[:space:]]+#op://[除去]#g' \
    -e 's#(https?://)[^[:space:]/@:]+(:[^[:space:]/@]*)?@#\1[除去]@#Ig' \
    -e 's/(gh[pousr]_|github_pat_|sk-ant-|sk-|xox[abprs]-|AKIA|AIza|eyJ)[A-Za-z0-9_.-]{8,}/[トークンを除去]/g' \
    -e 's/([A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION|CREDENTIAL)[A-Za-z0-9_]*)[[:space:]]*[=:][[:space:]]*[^[:space:]]+/\1=[除去]/Ig'
}

# diag_excerpt <ファイル>: 末尾30行・2000文字までを機密除去して返す（無ければ空）
diag_excerpt() {
  local file="${1:-}"
  [[ -n "$file" && -s "$file" ]] || return 0
  tail -n 30 "$file" 2>/dev/null | tr -d '\000' | diag_redact | tail -c 2000 || true
}

# diag_stage: 最後に確認できた工程（進捗ファイルの現在の工程）。無ければ空
diag_stage() {
  [[ -n "${RELEASE_PROGRESS_FILE:-}" && -s "$RELEASE_PROGRESS_FILE" ]] || return 0
  jq -r '.progress.step // empty' "$RELEASE_PROGRESS_FILE" 2>/dev/null || true
}

# diag_payload <原因> [終了コード] [抜粋ファイル] [工程]: releaseReviewとして報告するJSON
diag_payload() {
  local cause="$1" code="${2:-}" excerpt_file="${3:-}" stage="${4:-}"
  [[ -n "$stage" ]] || stage="$(diag_stage)"
  jq -nc --arg cause "$cause" --arg code "$code" --arg stage "$stage" --arg excerpt "$(diag_excerpt "$excerpt_file")" \
    '{diagnostic: ({cause: $cause}
      + (if $stage == "" then {} else {stage: $stage} end)
      + (if $code == "" then {} else {exitCode: ($code | tonumber)} end)
      + (if $excerpt == "" then {} else {excerpt: $excerpt} end))}' 2>/dev/null || true
}

# diag_ai_cause <終了コード> <ログ>: AI CLIが非0で終わったときの原因。事実が無ければ unknown
diag_ai_cause() {
  local code="$1" log="$2"
  case "$code" in
    124 | 137) printf 'timeout'; return ;;
    126 | 127) printf 'launch_failed'; return ;;
  esac
  if [[ -s "$log" ]] && tail -n 60 "$log" | grep -qiE 'not logged in|please (log ?in|run .*login)|unauthorized|authentication (failed|error)|invalid (api key|token)|\b401\b|expired (token|session)'; then
    printf 'auth_failed'
    return
  fi
  printf 'unknown'
}

# review_report <running|succeeded|failed> <メッセージ> [releaseReview JSON]
review_report() {
  local status="$1" message="${2:-}" result="${3:-}"
  local app_base_url dispatch_secret host_name body progress="null"
  [[ -n "$JOB_ID" ]] || return 0
  # 実行中の報告は、heartbeatからも最新の工程を送れるようファイルから読む（#4277）
  if [[ "$status" == "running" && -s "$RELEASE_PROGRESS_FILE" ]]; then
    message="$(release_progress_message)"
    progress="$(release_progress_json)"
  fi
  app_base_url="$(_review_usage_env_value APP_BASE_URL)"
  dispatch_secret="$(_review_usage_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 0
  host_name="$(_review_usage_env_value DISPATCH_HOST_NAME)"
  [[ -n "$host_name" ]] || host_name="$(hostname -s 2>/dev/null || printf 'unknown')"
  command -v jq >/dev/null 2>&1 || return 0
  body="$(jq -nc --arg jobId "$JOB_ID" --arg host "$host_name" --arg status "$status" \
    --arg message "$message" --arg session "${TMUX_SESSION_NAME:-}" --arg result "$result" \
    --argjson progress "$progress" \
    '{jobId: $jobId, host: $host, status: $status}
      + (if $message == "" then {} else {message: $message} end)
      + (if $progress == null then {} else {progress: $progress} end)
      + (if $session == "" then {} else {tmuxSessionName: $session} end)
      + (if $result == "" then {} else {releaseReview: ($result | fromjson)} end)')" || return 0
  # シークレットはコマンドライン引数に置かない（`ps`で見えるため）
  printf 'Authorization: Bearer %s\n' "$dispatch_secret" |
    curl --silent --max-time 15 --request POST --header @- \
      --header 'Content-Type: application/json' --data-binary "$body" \
      --output /dev/null "${app_base_url%/}/api/dispatch/report" 2>/dev/null || true
  return 0
}

heartbeat_start() {
  (
    while sleep "$HEARTBEAT_SECONDS"; do
      review_report running "$RUNNING_MESSAGE"
    done
  ) >/dev/null 2>&1 &
  HEARTBEAT_PID=$!
}

heartbeat_stop() {
  [[ -n "$HEARTBEAT_PID" ]] || return 0
  local child
  for child in $(pgrep -P "$HEARTBEAT_PID" 2>/dev/null || true); do
    kill "$child" 2>/dev/null || true
  done
  kill "$HEARTBEAT_PID" 2>/dev/null || true
  wait "$HEARTBEAT_PID" 2>/dev/null || true
  HEARTBEAT_PID=""
}

# どの経路で終わっても終了を1回だけ報告する
finish() {
  local status="$1" message="$2" result="${3:-}"
  [[ "$JOB_REPORTED" -eq 0 ]] || return 0
  JOB_REPORTED=1
  heartbeat_stop
  review_report "$status" "$message" "$result"
}

cleanup() {
  local code=$?
  if ((code != 0)); then
    # 想定外の失敗。原因は特定できないので unknown とし、最後の工程とstderr末尾だけを残す
    finish failed "全体レビューの実行中に失敗しました（終了コード ${code}）。" \
      "$(diag_payload unknown "$code" "$ERR_FILE")"
  fi
  [[ -n "$ERR_FILE" ]] && rm -f "$ERR_FILE"
  if [[ -n "$WORKTREE" && -n "$LOCAL_PATH" ]]; then
    git -C "$LOCAL_PATH" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
  fi
  release_progress_cleanup
}

# AIの最終応答から最後のjsonコードブロック（無ければ全体）を取り出す。JSONでなければ非0
extract_result_json() {
  local file="$1" block
  block="$(awk '/^```json/{buf="";inblk=1;next} /^```/{if(inblk){last=buf;inblk=0};next} inblk{buf=buf $0 "\n"} END{printf "%s", last}' "$file")"
  [[ -n "$block" ]] || block="$(cat "$file")"
  jq -ce 'select(type == "object")' <<<"$block" 2>/dev/null
}

main() {
  local owner="$1" repo="$2" pr_number="$3" base_sha="$4" head_sha="$5"
  JOB_ID="$6"
  local agent="$7" claude_model="${8:-}" codex_model="${9:-}"
  local full_name="$owner/$repo" prompt_file output_file log_file ai_json
  local total_files=0 reviewed_files=0 used_bytes=0 file file_diff size coverage="" diff_text="" prs_text=""
  local -a files=() omitted=() claude_args=() codex_args=()

  trap cleanup EXIT
  # 想定外の失敗でstderrの末尾を診断へ載せるため、写しを取る（端末への出力はそのまま残る）
  ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/issue-deck-release-review-err.XXXXXX")"
  exec 2> >(tee -a "$ERR_FILE" >&2)
  TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-}"
  for tool in git jq timeout; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Error: $tool コマンドが見つかりません。" >&2; exit 1; }
  done
  [[ "$pr_number" =~ ^[1-9][0-9]*$ && "$base_sha" =~ ^[0-9a-f]{40,64}$ && "$head_sha" =~ ^[0-9a-f]{40,64}$ ]] || {
    finish failed "PR番号またはSHAが不正です"
    return 0
  }
  case "$agent" in
    claude) [[ "$claude_model" =~ ^(fable|opus|sonnet)$ ]] || { finish failed "受け取ったClaudeモデルが不正です: $claude_model"; return 0; } ;;
    codex) [[ "$codex_model" =~ ^[A-Za-z0-9._-]+$ ]] || { finish failed "受け取ったCodexモデルが不正です: $codex_model"; return 0; } ;;
    *) finish failed "受け取った担当が不正です: $agent"; return 0 ;;
  esac

  release_progress_init '["prepare","diff","review","finalize"]'
  release_progress_set prepare 0 "$RUNNING_MESSAGE"
  review_report running "$RUNNING_MESSAGE"
  heartbeat_start
  LOCAL_PATH="$(local_repo_resolve_path "$full_name")"
  mkdir -p "$WORK_ROOT"
  WORKTREE="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}"
  rm -rf "$WORKTREE"
  git -C "$LOCAL_PATH" worktree prune >/dev/null 2>&1 || true
  git -C "$LOCAL_PATH" fetch --quiet origin main "$head_sha" 2>/dev/null ||
    git -C "$LOCAL_PATH" fetch --quiet origin 2>/dev/null || true
  git -C "$LOCAL_PATH" cat-file -e "${base_sha}^{commit}" 2>/dev/null &&
    git -C "$LOCAL_PATH" cat-file -e "${head_sha}^{commit}" 2>/dev/null || {
    finish failed "対象のコミットを取得できません（base ${base_sha:0:7} / head ${head_sha:0:7}）" \
      "$(diag_payload target_missing "" "" prepare)"
    return 0
  }
  git -C "$LOCAL_PATH" worktree add --detach "$WORKTREE" "$head_sha" >/dev/null 2>&1

  # 差分の材料。ファイルごとの差分を、予算の範囲で先頭から詰める
  release_progress_set diff 1 "リリースの差分を取得しています"
  review_report running ""
  mapfile -t files < <(git -C "$WORKTREE" diff --name-only "$base_sha...$head_sha")
  total_files="${#files[@]}"
  if ((total_files == 0)); then
    finish succeeded "差分がありません" \
      "$(jq -nc '{state: "passed", summary: "mainとの差分がありません", findings: [], totalFiles: 0, reviewedFiles: 0}')"
    return 0
  fi
  for file in "${files[@]}"; do
    file_diff="$(git -C "$WORKTREE" diff "$base_sha...$head_sha" -- "$file")"
    size="${#file_diff}"
    if ((used_bytes + size > DIFF_BUDGET_BYTES)); then
      omitted+=("$file")
      continue
    fi
    diff_text+="$file_diff"$'\n'
    used_bytes=$((used_bytes + size))
    reviewed_files=$((reviewed_files + 1))
  done
  if ((${#omitted[@]} > 0)); then
    coverage="差分${total_files}ファイルのうち${reviewed_files}ファイルの差分を下に載せました。**次のファイルは差分を載せていません**（必要なら作業ディレクトリで\`git diff ${base_sha}...${head_sha} -- <パス>\`を読んで確認してください）:"$'\n'
    coverage+="$(printf -- '- %s\n' "${omitted[@]:0:100}")"
  else
    coverage="差分${total_files}ファイルすべてを下に載せました。"
  fi
  prs_text="$(git -C "$WORKTREE" log --format='- %s' "$base_sha..$head_sha" | head -n 200)"

  prompt_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.prompt"
  output_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.out"
  log_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.log"
  # 前回の実行の出力・ログを今回の結果として読まない（同じSHAの再実行）
  rm -f "$output_file" "$log_file"
  python3 - "$SCRIPT_DIR/prompts/release-review-agent.md" "$prompt_file" "$full_name" "$pr_number" "$base_sha" "$head_sha" \
    "$coverage" "$prs_text" "$diff_text" <<'PY'
import sys
template, out, repo, pr, base, head, coverage, prs, diff = sys.argv[1:10]
text = open(template, encoding="utf-8").read()
for key, value in {
    "{{REPOSITORY}}": repo, "{{PR_NUMBER}}": pr, "{{BASE_SHA}}": base, "{{HEAD_SHA}}": head,
    "{{COVERAGE}}": coverage, "{{PULL_REQUESTS}}": prs, "{{DIFF}}": diff,
}.items():
    text = text.replace(key, value)
open(out, "w", encoding="utf-8").write(text)
PY

  RUNNING_MESSAGE="全体レビューを実行中です（${agent}・${claude_model:-$codex_model}・差分${reviewed_files}/${total_files}ファイル）"
  release_progress_set review 2 "$RUNNING_MESSAGE" "" "$total_files"
  review_report running "$RUNNING_MESSAGE"
  local exit_code=0
  if [[ "$agent" == "codex" ]]; then
    local codex_command
    codex_command="$(agent_cli_codex_command)"
    command -v "$codex_command" >/dev/null 2>&1 || {
      finish failed "Codex CLIが見つかりません" "$(diag_payload launch_failed "" "" review)"
      return 0
    }
    codex_args=(exec --sandbox read-only --ephemeral -m "$codex_model" --output-last-message "$output_file" -C "$WORKTREE")
    (cd "$WORKTREE" && timeout -k 60 "$TIMEOUT_SECONDS" "$codex_command" "${codex_args[@]}" <"$prompt_file" >"$log_file" 2>&1) || exit_code=$?
  else
    command -v claude >/dev/null 2>&1 || {
      finish failed "claude CLIが見つかりません" "$(diag_payload launch_failed "" "" review)"
      return 0
    }
    claude_args=(-p --model "$claude_model" --allowedTools Read Grep Glob)
    (cd "$WORKTREE" && timeout -k 60 "$TIMEOUT_SECONDS" claude "${claude_args[@]}" <"$prompt_file" >"$output_file" 2>"$log_file") || exit_code=$?
  fi
  if ((exit_code != 0)); then
    local cause
    cause="$(diag_ai_cause "$exit_code" "$log_file")"
    finish failed "全体レビューを完走できませんでした（終了コード ${exit_code}）" \
      "$(diag_payload "$cause" "$exit_code" "$log_file" review)"
    return 0
  fi
  release_progress_set finalize 3 "全体レビューの結果を整理しています" "" "$total_files"
  review_report running ""
  if ! ai_json="$(extract_result_json "$output_file")"; then
    finish failed "全体レビューの結果をJSONとして読めませんでした" \
      "$(diag_payload parse_failed "" "$output_file" finalize)"
    return 0
  fi
  # 確認できたファイル数はこちらで確定した値を載せる（AIの自己申告に任せない）
  ai_json="$(jq -c --argjson total "$total_files" --argjson reviewed "$reviewed_files" \
    '. + {totalFiles: $total, reviewedFiles: $reviewed}' <<<"$ai_json")" ||
    { finish failed "全体レビューの結果を整形できませんでした" "$(diag_payload parse_failed "" "" finalize)"; return 0; }
  finish succeeded "全体レビューを完了しました" "$ai_json"
}

if [[ "${1:-}" == "--run" ]]; then
  shift
  [[ $# -ge 9 ]] || {
    echo "Usage: scripts/run-release-review.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <agent> <claudeモデル> <codexモデル>" >&2
    exit 1
  }
  main "$@"
fi
