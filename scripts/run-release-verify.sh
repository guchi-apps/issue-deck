#!/usr/bin/env bash
# リリースPR（base=main・head=release-main/v*）の固定内容に対する統合検証（#4237・#4212）。
#
# 呼ぶのはサブPCのpoller。DispatchJob（`RELEASE_VERIFY`）を取ったpollerが、tmuxの中で起動する。
# mainの先端（base SHA）へリリースのhead SHAをマージした**統合状態**を一時worktreeに作り、
# issue-deckが渡した検証コマンド（`src/lib/release-verification-config.ts`の`integrationCommands`）を
# 順に実行する。**実行内容はサーバーの設定が正で、チェックアウトの中身には決めさせない。**
#
#   scripts/run-release-verify.sh <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <コマンドのJSON配列> <Mac検証 true|false>
#
# 結果は`/api/dispatch/report`の`releaseVerification`として報告する（記録先はジョブの対象で決まり、
# ここからは選べない）。**成功にしてはいけないもの**: 検証コマンドが無い・マージできない・
# Mac検証が未接続。未接続は`unverifiedScope`付きの`passed`（＝要確認）として区別する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/review-usage.sh
source "$SCRIPT_DIR/lib/review-usage.sh"
# shellcheck source=scripts/lib/release-progress.sh
source "$SCRIPT_DIR/lib/release-progress.sh"

WORK_ROOT="${ISSUE_DECK_RELEASE_VERIFY_ROOT:-${TMPDIR:-/tmp}/issue-deck-release-verify}"
STEP_TIMEOUT="${ISSUE_DECK_RELEASE_VERIFY_STEP_TIMEOUT_SECONDS:-1500}"
HEARTBEAT_SECONDS="${ISSUE_DECK_RELEASE_VERIFY_HEARTBEAT_SECONDS:-60}"
MAC_HOST_NAME="${MAC_HOST:-guchimac-mini}"

JOB_ID=""
JOB_REPORTED=0
RUNNING_MESSAGE="統合検証を準備しています"
HEARTBEAT_PID=""

# release_verify_report <running|succeeded|failed> <メッセージ> [releaseVerification JSON]
release_verify_report() {
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
      + (if $result == "" then {} else {releaseVerification: ($result | fromjson)} end)')" || return 0
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
      release_verify_report running "$RUNNING_MESSAGE"
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

# どの経路で終わっても終了を1回だけ報告する。報告前に落ちたら`failed`（生存報告の途絶を待たせない）
finish() {
  local status="$1" message="$2" result="${3:-}"
  [[ "$JOB_REPORTED" -eq 0 ]] || return 0
  JOB_REPORTED=1
  heartbeat_stop
  release_verify_report "$status" "$message" "$result"
}

WORKTREE=""
LOCAL_PATH=""
cleanup() {
  local code=$?
  if ((code != 0)); then
    finish failed "統合検証の実行中に失敗しました（終了コード ${code}）。サブPCのtmuxセッション ${TMUX_SESSION_NAME:-不明}を確認してください。"
  fi
  if [[ -n "$WORKTREE" && -n "$LOCAL_PATH" ]]; then
    git -C "$LOCAL_PATH" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
  fi
  release_progress_cleanup
}

# 検証結果のJSON。state=passed|failed|needs_check|not_applicable
result_json() {
  local state="$1" summary="$2" unverified="${3:-}" evidence="${4:-}"
  jq -nc --arg state "$state" --arg summary "$summary" --arg unverified "$unverified" --arg evidence "$evidence" \
    '{state: $state, summary: $summary}
      + (if $unverified == "" then {} else {unverifiedScope: $unverified} end)
      + (if $evidence == "" then {} else {evidenceUrl: $evidence} end)'
}

main() {
  local owner="$1" repo="$2" pr_number="$3" base_sha="$4" head_sha="$5"
  JOB_ID="$6"
  local commands_json="$7" mac_check="${8:-false}"
  local full_name="$owner/$repo" summary="" unverified="" evidence="" step output_file ci_json ci_url
  local plan command_count step_index=0

  trap cleanup EXIT
  TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-}"
  for tool in git gh jq timeout; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Error: $tool コマンドが見つかりません。" >&2; exit 1; }
  done
  [[ "$pr_number" =~ ^[1-9][0-9]*$ && "$base_sha" =~ ^[0-9a-f]{40,64}$ && "$head_sha" =~ ^[0-9a-f]{40,64}$ ]] || {
    finish failed "PR番号またはSHAが不正です"
    return 0
  }
  jq -e 'type == "array" and length > 0 and all(type == "string")' <<<"$commands_json" >/dev/null 2>&1 || {
    finish succeeded "検証コマンドが渡されませんでした" \
      "$(result_json not_applicable "このリポジトリには統合検証のコマンドがありません（対象外）")"
    return 0
  }

  # 工程の計画（準備→統合→検証コマンド…→Mac検証）。heartbeatより先に作り、子プロセスへも見せる
  plan="$(release_progress_integration_plan "$commands_json" "$mac_check")"
  command_count="$(jq 'length' <<<"$commands_json")"
  release_progress_init "$plan"
  release_progress_set prepare 0 "$RUNNING_MESSAGE"
  release_verify_report running "$RUNNING_MESSAGE"
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
    finish failed "対象のコミットを取得できません（base ${base_sha:0:7} / head ${head_sha:0:7}）"
    return 0
  }

  # 統合状態: mainの先端（base）へリリースのheadをマージする。競合はそのまま失敗として返す
  release_progress_set merge 1 "mainの先端へリリースを統合しています"
  release_verify_report running ""
  git -C "$LOCAL_PATH" worktree add --detach "$WORKTREE" "$base_sha" >/dev/null 2>&1
  if ! git -C "$WORKTREE" -c user.name="Claude Code" -c user.email="claude-code@example.com" \
    merge --no-edit "$head_sha" >/dev/null 2>&1; then
    finish succeeded "mainとリリースのheadを統合できませんでした（競合）" \
      "$(result_json failed "mainの先端（${base_sha:0:7}）とリリースhead（${head_sha:0:7}）の統合でコンフリクトしました")"
    return 0
  fi
  summary="統合対象: main ${base_sha:0:7} + release head ${head_sha:0:7}"$'\n'

  # 既存CIの証跡（head SHAの成功）。**再利用する証跡であり、統合状態のビルド・テストの代わりではない**
  ci_json="$(gh run list --repo "$full_name" --workflow ci.yml --commit "$head_sha" --json conclusion,url --limit 1 2>/dev/null || printf '[]')"
  ci_url="$(jq -r '.[0] | select(.conclusion == "success") | .url // empty' <<<"$ci_json" 2>/dev/null || true)"
  if [[ -n "$ci_url" ]]; then
    evidence="$ci_url"
    summary+="既存CI（ci.yml・head SHA）: 成功（実施済み・証跡再利用）"$'\n'
  else
    summary+="既存CI（ci.yml・head SHA）: 成功の記録なし（未実施または失敗）"$'\n'
  fi

  # 統合状態でのビルド・テスト
  while IFS= read -r step; do
    RUNNING_MESSAGE="統合検証を実行中です: ${step}"
    release_progress_set "$(jq -r --argjson i "$((2 + step_index))" '.[$i]' <<<"$plan")" \
      "$((2 + step_index))" "$RUNNING_MESSAGE" "$step"
    step_index=$((step_index + 1))
    release_verify_report running "$RUNNING_MESSAGE"
    output_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.out"
    if (cd "$WORKTREE" && timeout "$STEP_TIMEOUT" bash -c "$step") >"$output_file" 2>&1; then
      summary+="実施・成功: ${step}"$'\n'
    else
      summary+="実施・失敗: ${step}"$'\n'"$(tail -n 20 "$output_file")"$'\n'
      finish succeeded "統合検証が失敗しました: ${step}" "$(result_json failed "$summary" "" "$evidence")"
      return 0
    fi
  done < <(jq -r '.[]' <<<"$commands_json")

  # Mac検証。iosの差分が無ければ対象外、未接続は成功にせず未確認範囲として残す
  if [[ "$mac_check" == "true" ]]; then
    if [[ -z "$(git -C "$WORKTREE" diff --name-only "$base_sha" "$head_sha" -- ios 2>/dev/null | head -1)" ]]; then
      summary+="Mac検証: 対象外（ios/に差分なし）"$'\n'
    elif [[ ! -x "$WORKTREE/ios/scripts/remote-build-check.sh" ]]; then
      unverified="Mac検証（remote-build-check.sh）が未接続です"
      summary+="Mac検証: 未実施（スクリプトがありません）"$'\n'
    elif ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$MAC_HOST_NAME" true >/dev/null 2>&1; then
      unverified="Mac（${MAC_HOST_NAME}）へ接続できず、iOSのビルドを確認できていません"
      summary+="Mac検証: 未実施（Macへ接続できません）"$'\n'
    else
      RUNNING_MESSAGE="Macでのビルド確認を実行中です"
      release_progress_set mac "$((2 + command_count))" "$RUNNING_MESSAGE"
      release_verify_report running "$RUNNING_MESSAGE"
      if (cd "$WORKTREE" && timeout "$STEP_TIMEOUT" bash ios/scripts/remote-build-check.sh) >"$WORK_ROOT/${repo}-${pr_number}-mac.out" 2>&1; then
        summary+="Mac検証: 実施・成功"$'\n'
      else
        summary+="Mac検証: 実施・失敗"$'\n'"$(tail -n 20 "$WORK_ROOT/${repo}-${pr_number}-mac.out")"$'\n'
        finish succeeded "Mac検証が失敗しました" "$(result_json failed "$summary" "" "$evidence")"
        return 0
      fi
    fi
  fi

  finish succeeded "統合検証を完了しました" "$(result_json passed "$summary" "$unverified" "$evidence")"
}

if [[ "${1:-}" == "--run" ]]; then
  shift
  [[ $# -ge 7 ]] || {
    echo "Usage: scripts/run-release-verify.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <コマンドJSON> [Mac検証 true|false]" >&2
    exit 1
  }
  main "$@"
fi
