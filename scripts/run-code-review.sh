#!/usr/bin/env bash
# リポジトリ全体のコードレビュー（#698）を1回走らせ、**結果が届いたかを確かめてから**ジョブへ
# 報告するランナー（#4116）。
#
# 呼ぶのは`scripts/start-code-review.sh`が立てるtmuxセッションの中だけ（直接は叩かない）。
#
#   run-code-review.sh --repo <owner/repo> --issue <番号> --workdir <dir> --prompt <file> \
#     --log <file> --timeout <秒> --job-id <ID|空> --session <tmux名> -- <claudeの引数...>
#
# ## なぜランナーを挟むのか
#
# 以前はpollerが「tmuxが立った」時点でジョブを`succeeded`にし、その後の`claude -p`の終了コード・
# 時間切れ・結果コメントの投稿の成否はどこにも報告されなかった。画面は結果コメントの有無だけで
# 「レビュー中」を出すため、利用上限で落ちた・投稿に失敗した・起動すらしていないレビューが
# 何日も「レビュー中」に残った（#4116）。
#
# ## 報告する状態（`/api/dispatch/report`）
#
# | 状況 | 報告 |
# | --- | --- |
# | 走っている間 | `running`（既定60秒ごとの生存報告。途絶えるとissue-deckが10分で`TIMEOUT`にする） |
# | 結果コメントが届いている | `succeeded`（`claude`の終了コードに関わらず。結果が正） |
# | 実行上限に達した | `failed`＋`timedOut: true`（issue-deckは`TIMEOUT`として記録する） |
# | `claude`が非0で終わった | `failed`（ログの末尾を添える。利用上限・認証切れはここに出る） |
# | 正常終了したが結果コメントが無い | `failed`（「結果未投稿」。指摘なしとは扱わない） |
# | 出力に結果はあるが投稿できなかった | `failed`（「投稿エラー」。結果はログに残る） |
#
# **結果の到達は、このジョブの実行の印（`<!-- issue-deck-code-review-run:<ジョブID> -->`）が
# 付いた結果コメントで確かめる。** 印の無い結果コメント（印を知らない対象リポジトリ独自の
# プロンプト）は、この実行の開始以降に作られたものだけを数える。
#
# **生成済みの結果は捨てない。** エージェントが投稿に失敗しても、最終応答に結果コメントの全文が
# あればランナーが印を付けて投稿し直す。投稿の前に毎回「もう届いているか」を確かめるので、
# 再試行で同じ結果が2件付くことはない。
#
# 報告に失敗しても（本番の一時的な不通など）、終了の報告は間隔を空けて送り直す。届かないまま
# 生存報告が途絶えた場合はissue-deck側が`TIMEOUT`にし、後から届いた終了の報告で上書きされる
# （`reportDispatchJob`の`CODE_REVIEW`の扱い）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/review-usage.sh
source "$SCRIPT_DIR/lib/review-usage.sh"

REPORT_MARKER='<!-- issue-deck-code-review-report -->'
RUN_MARKER_PREFIX='<!-- issue-deck-code-review-run:'
HEARTBEAT_SECONDS="${ISSUE_DECK_CODE_REVIEW_HEARTBEAT_SECONDS:-60}"
FINAL_REPORT_ATTEMPTS="${ISSUE_DECK_CODE_REVIEW_REPORT_ATTEMPTS:-20}"
FINAL_REPORT_INTERVAL="${ISSUE_DECK_CODE_REVIEW_REPORT_INTERVAL_SECONDS:-30}"
POST_ATTEMPTS=3

REPOSITORY="" ISSUE_NUMBER="" WORKDIR="" PROMPT_FILE="" LOG_FILE="" TIMEOUT_SECONDS="" JOB_ID="" SESSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPOSITORY="$2"; shift 2 ;;
    --issue) ISSUE_NUMBER="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --prompt) PROMPT_FILE="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    --timeout) TIMEOUT_SECONDS="$2"; shift 2 ;;
    --job-id) JOB_ID="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "Error: 不明な引数です: $1" >&2; exit 2 ;;
  esac
done
CLAUDE_ARGS=("$@")

if [[ -z "$REPOSITORY" || ! "$ISSUE_NUMBER" =~ ^[1-9][0-9]*$ || -z "$PROMPT_FILE" || -z "$LOG_FILE" ]]; then
  echo "Error: 引数が足りません。scripts/start-code-review.sh から起動してください。" >&2
  exit 2
fi

if [[ -n "$WORKDIR" ]] && ! cd "$WORKDIR"; then
  echo "Error: 作業ディレクトリへ移れません: $WORKDIR" >&2
  exit 2
fi

RUN_MARKER=""
[[ -n "$JOB_ID" ]] && RUN_MARKER="${RUN_MARKER_PREFIX}${JOB_ID} -->"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
HEARTBEAT_PID=""

# report_status <running|succeeded|failed> <メッセージ> [終了コード] [timedOut(true/空)] [試行回数]
report_status() {
  local status="$1" message="$2" exit_code="${3:-}" timed_out="${4:-}" attempts="${5:-1}"
  local app_base_url dispatch_secret host_name body http attempt
  [[ -n "$JOB_ID" ]] || return 0
  app_base_url="$(_review_usage_env_value APP_BASE_URL)"
  dispatch_secret="$(_review_usage_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 1
  host_name="$(_review_usage_env_value DISPATCH_HOST_NAME)"
  [[ -n "$host_name" ]] || host_name="$(hostname -s 2>/dev/null || printf 'unknown')"
  body="$(jq -nc --arg jobId "$JOB_ID" --arg host "$host_name" --arg status "$status" \
    --arg message "$message" --arg session "$SESSION" --arg exitCode "$exit_code" \
    --arg timedOut "$timed_out" \
    '{jobId: $jobId, host: $host, status: $status, message: $message}
      + (if $session == "" then {} else {tmuxSessionName: $session} end)
      + (if $exitCode == "" then {} else {exitCode: ($exitCode | tonumber)} end)
      + (if $timedOut == "true" then {timedOut: true} else {} end)')" || return 1
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    # シークレットはコマンドライン引数に置かない（`ps`で見えるため）。
    http="$(printf 'Authorization: Bearer %s\n' "$dispatch_secret" |
      curl --silent --max-time 15 --request POST --header @- \
        --header 'Content-Type: application/json' --data-binary "$body" \
        --output /dev/null --write-out '%{http_code}' "${app_base_url%/}/api/dispatch/report" 2>/dev/null)"
    case "$http" in
      2??) return 0 ;;
      # 受け口が受け付けない報告（ジョブが無い・別ホスト・形が不正）は送り直しても変わらない
      4??) echo "警告: 状態の報告が受け付けられませんでした（HTTP $http・$status）。" >&2; return 1 ;;
    esac
    if (( attempt < attempts )); then
      echo "警告: 状態の報告に失敗しました（HTTP ${http:-000}・$status・$attempt/$attempts）。${FINAL_REPORT_INTERVAL}秒後に送り直します。" >&2
      sleep "$FINAL_REPORT_INTERVAL"
    fi
  done
  return 1
}

# 生存報告。**親（このランナー）が消えたら止まる**——tmuxごと落とされた後に孤児として
# 「実行中」を報告し続けると、プロセス消失をissue-deckが検知できなくなる。
heartbeat_start() {
  [[ -n "$JOB_ID" ]] || return 0
  local parent=$$
  (
    while sleep "$HEARTBEAT_SECONDS"; do
      kill -0 "$parent" 2>/dev/null || exit 0
      report_status running "コードレビューを実行中です（開始 ${STARTED_AT}）" >/dev/null 2>&1 || true
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

# この実行の結果コメントのURLを出す（無ければ空・取得できなければ非0）。
find_report_comment() {
  gh api --paginate "repos/$REPOSITORY/issues/$ISSUE_NUMBER/comments?per_page=100" \
    --jq ".[] | select(.body | contains(\"$REPORT_MARKER\"))
      | select(
          (\"$RUN_MARKER\" != \"\" and (.body | contains(\"$RUN_MARKER\")))
          or ((.body | contains(\"$RUN_MARKER_PREFIX\") | not) and .created_at >= \"$STARTED_AT\")
        ) | .html_url" 2>/dev/null | tail -n 1
}

# 最終応答（ログ）から結果コメントの全文を取り出す。無ければ非0。
extract_report_from_log() {
  local out="$1"
  python3 - "$LOG_FILE" "$REPORT_MARKER" "$RUN_MARKER" >"$out" <<'PY' || return 1
import sys

log_path, marker, run_marker = sys.argv[1:4]
try:
    with open(log_path, encoding="utf-8", errors="replace") as f:
        text = f.read()
except OSError:
    sys.exit(1)
index = text.rfind(marker)
if index < 0:
    sys.exit(1)
body = text[index:].rstrip()
# 最終応答が```で囲まれていた場合の閉じフェンスを落とす
if body.endswith("```"):
    body = body[: -3].rstrip()
lines = body.split("\n")
if run_marker and run_marker not in body:
    lines.insert(1, run_marker)
if "<!-- issue-deck-agent:" not in body:
    lines.extend(["", "<!-- issue-deck-agent:implementer -->"])
sys.stdout.write("\n".join(lines) + "\n")
PY
}

echo "#$ISSUE_NUMBER: コードレビューを開始します（$REPOSITORY・上限 ${TIMEOUT_SECONDS}秒・ジョブ ${JOB_ID:-なし}）"
if [[ ! "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || ! command -v timeout >/dev/null 2>&1; then
  # ランチャーで確かめているが、上限なしで走らせない最後の砦
  report_status failed "実行上限を設定できないため、コードレビューを開始しませんでした（timeout=${TIMEOUT_SECONDS}）。" "" "" "$FINAL_REPORT_ATTEMPTS" || true
  exit 1
fi

report_status running "コードレビューを実行中です（開始 ${STARTED_AT}）" || true
heartbeat_start

cat "$PROMPT_FILE" | timeout -k 60 "$TIMEOUT_SECONDS" claude "${CLAUDE_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
CLAUDE_STATUS="${PIPESTATUS[1]}"

# --- 結果の到達を確かめる ------------------------------------------------------
REPORT_URL=""
LOOKUP_FAILED=0
if ! REPORT_URL="$(find_report_comment)"; then
  LOOKUP_FAILED=1
  REPORT_URL=""
fi

POST_ERROR=""
if [[ -z "$REPORT_URL" ]]; then
  SALVAGE_FILE="$(mktemp)"
  if extract_report_from_log "$SALVAGE_FILE"; then
    echo "#$ISSUE_NUMBER: 結果コメントが見当たらないため、最終応答の結果を投稿します。"
    for (( attempt = 1; attempt <= POST_ATTEMPTS; attempt++ )); do
      # 投稿の前に毎回確かめる（前の試行が実は届いていた場合に二重に付けない）
      REPORT_URL="$(find_report_comment || true)"
      [[ -n "$REPORT_URL" ]] && break
      if POST_OUTPUT="$(gh issue comment "$ISSUE_NUMBER" --repo "$REPOSITORY" --body-file "$SALVAGE_FILE" 2>&1)"; then
        REPORT_URL="$(find_report_comment || true)"
        [[ -n "$REPORT_URL" ]] || REPORT_URL="$(printf '%s\n' "$POST_OUTPUT" | grep -oE 'https://github.com/[^ ]+' | tail -n 1)"
        [[ -n "$REPORT_URL" ]] && break
      else
        POST_ERROR="$(printf '%s' "$POST_OUTPUT" | tail -c 300)"
      fi
      sleep 10
    done
  fi
  rm -f "$SALVAGE_FILE"
fi

heartbeat_stop

LOG_TAIL="$(grep -v '^[[:space:]]*$' "$LOG_FILE" 2>/dev/null | tail -n 5 | tail -c 600)"
if [[ -n "$REPORT_URL" ]]; then
  NOTE=""
  [[ "$CLAUDE_STATUS" -ne 0 ]] && NOTE="（Claude CLIの終了コード ${CLAUDE_STATUS}）"
  FINAL=(succeeded "レビュー結果の投稿を確認しました${NOTE}: $REPORT_URL" "$CLAUDE_STATUS" "")
elif [[ "$CLAUDE_STATUS" -eq 124 ]]; then
  FINAL=(failed "実行上限（${TIMEOUT_SECONDS}秒）に達したため打ち切りました。結果は投稿されていません。ログ: $LOG_FILE" "$CLAUDE_STATUS" true)
elif [[ "$CLAUDE_STATUS" -ne 0 ]]; then
  FINAL=(failed "Claude CLIが異常終了しました（終了コード ${CLAUDE_STATUS}）。ログ: $LOG_FILE ／ 末尾: ${LOG_TAIL}" "$CLAUDE_STATUS" "")
elif [[ -n "$POST_ERROR" ]]; then
  FINAL=(failed "レビュー結果は生成されましたが、投稿に失敗しました: ${POST_ERROR}。結果はログに残っています: $LOG_FILE" "$CLAUDE_STATUS" "")
elif [[ "$LOOKUP_FAILED" -eq 1 ]]; then
  FINAL=(failed "レビューは終了しましたが、結果コメントの有無をGitHubで確認できませんでした。ログ: $LOG_FILE" "$CLAUDE_STATUS" "")
else
  FINAL=(failed "レビューは終了しましたが、結果コメントが投稿されていません（結果未投稿）。ログ: $LOG_FILE ／ 末尾: ${LOG_TAIL}" "$CLAUDE_STATUS" "")
fi

echo "#$ISSUE_NUMBER: ${FINAL[1]}"
if ! report_status "${FINAL[0]}" "${FINAL[1]}" "${FINAL[2]}" "${FINAL[3]}" "$FINAL_REPORT_ATTEMPTS"; then
  echo "警告: 終了の報告を届けられませんでした。issue-deckは生存報告の途絶で時間切れとして扱います。" >&2
fi

# 結果が届かなかった実行はペインを残す（`remain-on-exit failed`。ログと合わせて確かめられるように）。
# pollerの本数の上限は死んだペインを数えないので、残しても次のレビューは止まらない
[[ "${FINAL[0]}" == succeeded ]]
