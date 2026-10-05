#!/usr/bin/env bash
# PRレビューのジョブ（`DispatchJob.kind = PR_REVIEW`・#3990）の状態を、レビューのスクリプトから
# issue-deckへ報告する処理。呼ぶのは`scripts/start-codex-pr-review.sh`。source して使う。
#
# **pollerではなくレビューのスクリプト自身が報告する。** Codexは数分〜30分走るため、pollerが
# 見張ると巡回が止まる。tmuxの中で走るスクリプトが、開始・生存報告・結果を`/api/dispatch/report`へ
# 送る。生存報告が10分途絶えるとissue-deck側がジョブを`TIMEOUT`にして最終マージ判定を再開する
# ので、**スクリプトが途中で落ちても結果待ちが残らない**。
#
# 認証情報（`APP_BASE_URL`・`DISPATCH_SECRET`・`DISPATCH_HOST_NAME`）はpollerが読み込んだ環境か
# `~/.config/issue-deck/dispatch.env`から取る（`review-usage.sh`と同じ）。**どれも失敗を呼び出し側へ
# 返さない**（報告できなくてもレビューそのものは続ける。届かなければ生存報告の途絶で時間切れになる）。

PR_REVIEW_REPORT_HEARTBEAT_PID=""
PR_REVIEW_RUNNING_MESSAGE=""

# pr_review_report <job_id> <running|succeeded|failed> <メッセージ> [verdict]
pr_review_report() {
  local job_id="$1" status="$2" message="${3:-}" verdict="${4:-}"
  local app_base_url dispatch_secret host_name body
  [[ -n "$job_id" ]] || return 0
  app_base_url="$(_review_usage_env_value APP_BASE_URL)"
  dispatch_secret="$(_review_usage_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 0
  host_name="$(_review_usage_env_value DISPATCH_HOST_NAME)"
  [[ -n "$host_name" ]] || host_name="$(hostname -s 2>/dev/null || printf 'unknown')"
  command -v jq >/dev/null 2>&1 || return 0
  body="$(jq -nc --arg jobId "$job_id" --arg host "$host_name" --arg status "$status" \
    --arg message "$message" --arg verdict "$verdict" --arg session "${TMUX_SESSION_NAME:-}" \
    '{jobId: $jobId, host: $host, status: $status}
      + (if $message == "" then {} else {message: $message} end)
      + (if $verdict == "" then {} else {reviewVerdict: $verdict} end)
      + (if $session == "" then {} else {tmuxSessionName: $session} end)')" || return 0
  # シークレットはコマンドライン引数に置かない（`ps`で見えるため）。
  printf 'Authorization: Bearer %s\n' "$dispatch_secret" |
    curl --silent --max-time 15 --request POST --header @- \
      --header 'Content-Type: application/json' --data-binary "$body" \
      --output /dev/null "${app_base_url%/}/api/dispatch/report" 2>/dev/null || true
  return 0
}

# 生存報告を一定間隔で送る子プロセスを起こす。`pr_review_heartbeat_stop`で止める
pr_review_heartbeat_start() {
  local job_id="$1" interval="${ISSUE_DECK_PR_REVIEW_HEARTBEAT_SECONDS:-60}"
  [[ -n "$job_id" ]] || return 0
  # 標準出力を閉じる: 子の`sleep`が親の出力を掴んだまま残ると、呼び出し側がパイプの終端を待ち続ける
  (
    while sleep "$interval"; do
      pr_review_report "$job_id" running "${PR_REVIEW_RUNNING_MESSAGE:-Codexでレビューを実行中です}"
    done
  ) >/dev/null 2>&1 &
  PR_REVIEW_REPORT_HEARTBEAT_PID=$!
}

pr_review_heartbeat_stop() {
  [[ -n "$PR_REVIEW_REPORT_HEARTBEAT_PID" ]] || return 0
  # 親だけを止めると子の`sleep`が孤児として残るので、子を先に止める
  local child
  for child in $(pgrep -P "$PR_REVIEW_REPORT_HEARTBEAT_PID" 2>/dev/null || true); do
    kill "$child" 2>/dev/null || true
  done
  kill "$PR_REVIEW_REPORT_HEARTBEAT_PID" 2>/dev/null || true
  wait "$PR_REVIEW_REPORT_HEARTBEAT_PID" 2>/dev/null || true
  PR_REVIEW_REPORT_HEARTBEAT_PID=""
}
