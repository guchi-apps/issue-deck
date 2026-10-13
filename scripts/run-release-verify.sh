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
# shellcheck source=scripts/lib/release-evidence.sh
source "$SCRIPT_DIR/lib/release-evidence.sh"

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
EVIDENCE_FILE=""
LOCK_DIR=""
cleanup() {
  local code=$?
  if ((code != 0)); then
    finish failed "統合検証の実行中に失敗しました（終了コード ${code}）。サブPCのtmuxセッション ${TMUX_SESSION_NAME:-不明}を確認してください。"
  fi
  if [[ -n "$WORKTREE" && -n "$LOCAL_PATH" ]]; then
    git -C "$LOCAL_PATH" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
  fi
  # ロックは所有者（自分のPID）のときだけ削除する
  [[ -n "$LOCK_DIR" && "$(cat "$LOCK_DIR/pid" 2>/dev/null || true)" == "$$" ]] && rm -rf "$LOCK_DIR"
  release_progress_cleanup
}

# 検証結果のJSON。state=passed|failed|needs_check|not_applicable
# failureKind（#4616）: merge_conflict|dependency_install_failed|setup_missing|timeout|test_failed|duplicate_run。
# 旧サーバーは未知のキーを無視する。未実施・取得失敗をコード不具合（test_failed）に置き換えないための区別
result_json() {
  local state="$1" summary="$2" unverified="${3:-}" evidence="${4:-}" kind="${5:-}"
  jq -nc --arg state "$state" --arg summary "$summary" --arg unverified "$unverified" --arg evidence "$evidence" --arg kind "$kind" \
    '{state: $state, summary: $summary}
      + (if $unverified == "" then {} else {unverifiedScope: $unverified} end)
      + (if $evidence == "" then {} else {evidenceUrl: $evidence} end)
      + (if $kind == "" then {} else {failureKind: $kind} end)'
}

# Mac検証を統合検証とは別の記録として報告する（#4366）。統合検証の結果JSONへ`mac`を足す。
# 統合検証の判定（unverifiedScope・failed）は従来どおり変えない。旧版のサーバーは`mac`を無視する。
MAC_RESULT_JSON=""
mac_result_set() {
  local state="$1" summary="$2" unverified="${3:-}"
  MAC_RESULT_JSON="$(jq -nc --arg state "$state" --arg summary "$summary" --arg unverified "$unverified" \
    '{state: $state, summary: $summary}
      + (if $unverified == "" then {} else {unverifiedScope: $unverified} end)')"
}
with_mac() {
  local result="$1"
  if [[ -z "$MAC_RESULT_JSON" ]]; then
    printf '%s' "$result"
    return 0
  fi
  jq -c --argjson mac "$MAC_RESULT_JSON" '. + {mac: $mac}' <<<"$result"
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

  # 同じ候補（base/head）の検証が進行中なら二重に準備・実行しない（#4616）。ロックは実行中のPIDで判定する
  EVIDENCE_FILE="$(evidence_file "$full_name" "$pr_number" "$base_sha" "$head_sha")"
  mkdir -p "$(dirname "$EVIDENCE_FILE")"
  local lock="${EVIDENCE_FILE%.json}.lock" holder="" acquired=false attempt
  # 取得は原子的な mkdir（既存なら失敗）。失敗したらPIDを確認し、持ち主が死んでいれば掃除して再取得する
  for attempt in 1 2 3; do
    if mkdir "$lock" 2>/dev/null; then
      printf '%s' "$$" >"$lock/pid"
      LOCK_DIR="$lock"
      acquired=true
      break
    fi
    holder=""
    [[ -f "$lock/pid" ]] && holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ -z "$holder" ]]; then
      # 取得直後でPID未書き込みの可能性があるため少し待ってから再確認する
      sleep 1
      [[ -f "$lock/pid" ]] && holder="$(cat "$lock/pid" 2>/dev/null || true)"
    fi
    [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null && break
    # 持ち主が不在: 所有トークン（死んだPID）が今も同じときだけ、解体用に名前を変えて1プロセスだけが掃除する
    if [[ "$(cat "$lock/pid" 2>/dev/null || true)" == "$holder" ]] && mv "$lock" "$lock.stale.$$" 2>/dev/null; then
      rm -rf "$lock.stale.$$"
    fi
  done
  if [[ "$acquired" != "true" ]]; then
    EVIDENCE_FILE=""
    finish succeeded "同じ候補の統合検証が進行中のため、開始しませんでした" \
      "$(result_json needs_check "同じ候補（base ${base_sha:0:7} / head ${head_sha:0:7}）の統合検証が実行中です（PID ${holder:-不明}）。完了を待ちます" \
        "進行中の統合検証の結果待ち" "" duplicate_run)"
    return 0
  fi
  evidence_init "$full_name" "$pr_number" "$base_sha" "$head_sha"

  # 統合状態: mainの先端（base）へリリースのheadをマージする。競合はそのまま失敗として返す
  release_progress_set merge 1 "mainの先端へリリースを統合しています"
  release_verify_report running ""
  git -C "$LOCAL_PATH" worktree add --detach "$WORKTREE" "$base_sha" >/dev/null 2>&1
  if ! git -C "$WORKTREE" -c user.name="Claude Code" -c user.email="claude-code@example.com" \
    merge --no-edit "$head_sha" >/dev/null 2>&1; then
    local conflicts
    conflicts="$(git -C "$WORKTREE" diff --name-only --diff-filter=U 2>/dev/null | head -n 20 | paste -sd, -)"
    evidence_finish "$EVIDENCE_FILE" failed merge_conflict "競合ファイル: ${conflicts:-不明}"
    finish succeeded "mainとリリースのheadを統合できませんでした（競合）" \
      "$(result_json failed "mainの先端（${base_sha:0:7}）とリリースhead（${head_sha:0:7}）の統合でコンフリクトしました。競合ファイル: ${conflicts:-不明}。統合状態の検証（テスト・型検査・ビルド）は未実施です" "" "" merge_conflict)"
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
    # IssueDeckのビルドは通常CIの正本から検証用envを適用する（#4331）。
    # ランナーは更新済みサブPC、cwdは要求された統合worktree。旧候補にも適用できる。
    # 他の検証や他リポジトリへダミー設定をexportしない。
    local -a step_command=(bash -c "$step")
    if [[ "$full_name" == "guchi-apps/issue-deck" && ( "$step" == "pnpm run build:ci" || "$step" == "pnpm build:ci" ) ]]; then
      step_command=(node "$SCRIPT_DIR/ci/run-required-checks.mjs" --group lint-and-build --check build)
    fi
    local step_code=0 step_kind=""
    (cd "$WORKTREE" && timeout "$STEP_TIMEOUT" "${step_command[@]}") >"$output_file" 2>&1 || step_code=$?
    if ((step_code == 0)); then
      summary+="実施・成功: ${step}"$'\n'
      evidence_add_step "$EVIDENCE_FILE" "$step" passed 0 "" ""
    else
      # 取得失敗・設定不足・時間切れ・不合格を区別する（未実施をコード不具合に置き換えない）
      step_kind="$(evidence_classify_step "$step" "$step_code")"
      summary+="実施・失敗（${step_kind}・終了コード ${step_code}）: ${step}"$'\n'"$(tail -n 20 "$output_file" | tr -d '\000' | evidence_redact)"$'\n'
      evidence_add_step "$EVIDENCE_FILE" "$step" failed "$step_code" "$step_kind" "$output_file"
      evidence_finish "$EVIDENCE_FILE" failed "$step_kind" "失敗したコマンド: ${step}"
      finish succeeded "統合検証が失敗しました（${step_kind}）: ${step}" "$(result_json failed "$summary" "" "$evidence" "$step_kind")"
      return 0
    fi
  done < <(jq -r '.[]' <<<"$commands_json")

  # Mac検証。iosの差分が無ければ対象外、未接続は成功にせず未確認範囲として残す
  if [[ "$mac_check" == "true" ]]; then
    if [[ -z "$(git -C "$WORKTREE" diff --name-only "$base_sha" "$head_sha" -- ios 2>/dev/null | head -1)" ]]; then
      summary+="Mac検証: 対象外（ios/に差分なし）"$'\n'
      mac_result_set not_applicable "ios/に差分がないため対象外です"
    elif [[ ! -x "$WORKTREE/ios/scripts/remote-build-check.sh" ]]; then
      unverified="Mac検証（remote-build-check.sh）が未接続です"
      summary+="Mac検証: 未実施（スクリプトがありません）"$'\n'
      mac_result_set needs_check "$unverified" "$unverified"
    elif ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$MAC_HOST_NAME" true >/dev/null 2>&1; then
      unverified="Mac（${MAC_HOST_NAME}）へ接続できず、iOSのビルドを確認できていません"
      summary+="Mac検証: 未実施（Macへ接続できません）"$'\n'
      mac_result_set needs_check "$unverified" "$unverified"
    else
      RUNNING_MESSAGE="Macでのビルド確認を実行中です"
      release_progress_set mac "$((2 + command_count))" "$RUNNING_MESSAGE"
      release_verify_report running "$RUNNING_MESSAGE"
      if (cd "$WORKTREE" && timeout "$STEP_TIMEOUT" bash ios/scripts/remote-build-check.sh) >"$WORK_ROOT/${repo}-${pr_number}-mac.out" 2>&1; then
        summary+="Mac検証: 実施・成功"$'\n'
        mac_result_set passed "Macでのビルド確認に成功しました"
      else
        summary+="Mac検証: 実施・失敗"$'\n'"$(tail -n 20 "$WORK_ROOT/${repo}-${pr_number}-mac.out")"$'\n'
        mac_result_set failed "$(tail -n 20 "$WORK_ROOT/${repo}-${pr_number}-mac.out")"
        evidence_finish "$EVIDENCE_FILE" failed test_failed "Mac検証の失敗"
        finish succeeded "Mac検証が失敗しました" "$(with_mac "$(result_json failed "$summary" "" "$evidence")")"
        return 0
      fi
    fi
  fi

  evidence_finish "$EVIDENCE_FILE" passed "" "$([[ -n "$unverified" ]] && echo "未確認: ${unverified}")"
  finish succeeded "統合検証を完了しました" "$(with_mac "$(result_json passed "$summary" "$unverified" "$evidence")")"
}

if [[ "${1:-}" == "--run" ]]; then
  shift
  [[ $# -ge 7 ]] || {
    echo "Usage: scripts/run-release-verify.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <コマンドJSON> [Mac検証 true|false]" >&2
    exit 1
  }
  main "$@"
fi
