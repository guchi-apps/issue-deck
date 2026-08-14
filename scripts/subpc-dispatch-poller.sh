#!/usr/bin/env bash
# サブPC側のディスパッチpoller（#1179 / #1176 Phase 2）。
#
# issue-deckの画面から積まれたジョブを取りに行き、ローカルのClaude Codeセッションを起動する。
#
#   issue-deckの画面「サブPCで開始」
#     → ジョブをキューに積む
#          ↑ ポーリング（共有シークレット認証）
#     このスクリプト
#     → scripts/start-local-session.sh → 対象リポジトリの scripts/start-issue.sh
#     → tmuxセッションが立つ（以降の進捗は start-issue.sh が POST /api/progress へ報告する）
#
# **pull型なのは、VPSがtailnetに参加しておらず、Tailscale SSHにforced commandが無いため**
# （#1176）。issue-deck側からSSHでキックする経路は採れない。
#
# 使い方:
#   scripts/subpc-dispatch-poller.sh            1巡だけ実行して終了する（systemd timerから呼ぶ）
#   scripts/subpc-dispatch-poller.sh --announce-only  申告だけ行い、ジョブは取らない
#   scripts/subpc-dispatch-poller.sh --dry-run  claimまで行い、起動はせずに内容を表示する
#
# **常駐しない。** 1巡で終わる作りにして、間隔と再起動はsystemdのtimerに任せる
# （deploy/subpc/issue-deck-dispatch-poller.timer）。常駐ループにすると、落ちたときの
# 復帰を自前で面倒みることになる。
#
# 設定は `~/.config/issue-deck/dispatch.env`（chmod 600）から読む。書式は
# deploy/subpc/dispatch.env.example を参照。
#
#   APP_BASE_URL          issue-deckのURL（本番を指す。ジョブがあるのは本番のDBだけ）
#   DISPATCH_SECRET       共有シークレット（issue-deck側の同名の環境変数と同じ値）
#   DISPATCH_HOST_NAME    このホストの名前（省略時は `hostname -s`）
#   DISPATCH_MAX_JOBS     1巡で取りに行く最大本数（省略時は1）
#
# 実行ログはjournaldに残る。`journalctl -u issue-deck-dispatch-poller -n 50` で読む。
# 起動したセッションの中身は `tmux attach -t <セッション名>`（セッション名はジョブの結果として
# issue-deckの画面にも出る）。

set -euo pipefail

# このpollerのバージョン。issue-deckへ申告し、受け口が古いまま動いていないかの手掛かりにする。
# **約束を変えたら上げる**（issue-deck側は表示するだけで、値による分岐は持たない）。
DISPATCH_POLLER_VERSION="1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 「どのリポジトリを起動できるか」の判定は受け口（start-local-session.sh）と共有する。
# **判定を二重に持つと、申告と実際の起動可否が必ずずれる**（#1179のコメント）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"

LAUNCHER="$SCRIPT_DIR/start-local-session.sh"

ANNOUNCE_ONLY=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --announce-only) ANNOUNCE_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "Usage: scripts/subpc-dispatch-poller.sh [--announce-only] [--dry-run]" >&2
      exit 1
      ;;
  esac
done

DISPATCH_ENV_FILE="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
if [[ -f "$DISPATCH_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DISPATCH_ENV_FILE"
  set +a
fi

for required_command in curl jq tmux; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done

if [[ -z "${APP_BASE_URL:-}" || -z "${DISPATCH_SECRET:-}" ]]; then
  echo "Error: APP_BASE_URL と DISPATCH_SECRET を設定してください（$DISPATCH_ENV_FILE）。" >&2
  echo "  書式は issue-deck の deploy/subpc/dispatch.env.example を参照してください。" >&2
  exit 1
fi

HOST_NAME="${DISPATCH_HOST_NAME:-$(hostname -s)}"
MAX_JOBS="${DISPATCH_MAX_JOBS:-1}"
BASE_URL="${APP_BASE_URL%/}"

# APIを叩く。本文を標準出力へ、HTTPステータスを最終行へ出す形は扱いにくいため、
# 一時ファイルへ本文を落としてステータスだけを返り値で見る。
# **シークレットはコマンドライン引数に置かない**（`ps` で他プロセスから見えるため）。
# `--header @-` で標準入力から渡す。
api_call() {
  local method="$1" path="$2" body="${3:-}"
  local response_file status
  response_file="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$response_file'" RETURN

  local curl_args=(
    --silent --show-error
    --max-time 30
    --request "$method"
    --header "Content-Type: application/json"
    --output "$response_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$body" ]]; then
    curl_args+=(--data "$body")
  fi

  status="$(printf 'Authorization: Bearer %s\n' "$DISPATCH_SECRET" |
    curl "${curl_args[@]}" --header @- "$BASE_URL$path" || true)"

  API_RESPONSE_BODY="$(cat "$response_file")"
  API_RESPONSE_STATUS="${status:-000}"
  [[ "$API_RESPONSE_STATUS" =~ ^2 ]]
}

# APIが答えられない理由を、次に何を直せばよいかが分かる形で出す。
report_api_failure() {
  local label="$1"
  case "$API_RESPONSE_STATUS" in
    503)
      echo "Error: $label: issue-deck側で DISPATCH_SECRET が未設定です（503）。" >&2
      ;;
    401)
      echo "Error: $label: DISPATCH_SECRET の値が一致しません（401）。$DISPATCH_ENV_FILE を確認してください。" >&2
      ;;
    000)
      echo "Error: $label: $BASE_URL へ接続できませんでした。" >&2
      ;;
    *)
      echo "Error: $label: HTTP $API_RESPONSE_STATUS $API_RESPONSE_BODY" >&2
      ;;
  esac
}

# --- 申告 ---------------------------------------------------------------------
# 「自分が実行できるリポジトリ」を申告する。issue-deck側はこの一覧を信じて割り当てるため、
# **start-local-session.sh と同じ4つの検証を通ったものだけ**を載せる（判定は共有ライブラリ）。
# 併せて生存報告も兼ねており、途絶えたホストはissue-deck側でofflineとして扱われる。
announce() {
  local repositories payload
  repositories="$(local_repo_list_runnable | jq -R . | jq -s .)"

  payload="$(jq -n \
    --arg host "$HOST_NAME" \
    --argjson repositories "$repositories" \
    --argjson contractVersion "$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION" \
    --arg agentVersion "$DISPATCH_POLLER_VERSION" \
    '{host: $host, repositories: $repositories, contractVersion: $contractVersion, agentVersion: $agentVersion}')"

  if ! api_call POST /api/dispatch/hosts "$payload"; then
    report_api_failure "ホストの申告に失敗しました"
    return 1
  fi
  echo "申告しました: $HOST_NAME → $(printf '%s' "$repositories" | jq -r 'join(", ")')"
  return 0
}

# --- ジョブの実行 -------------------------------------------------------------
report_job() {
  local job_id="$1" status="$2" message="${3:-}" session="${4:-}"
  local payload
  payload="$(jq -n \
    --arg jobId "$job_id" \
    --arg host "$HOST_NAME" \
    --arg status "$status" \
    --arg message "$message" \
    --arg tmuxSessionName "$session" \
    '{jobId: $jobId, host: $host, status: $status}
      + (if $message == "" then {} else {message: $message} end)
      + (if $tmuxSessionName == "" then {} else {tmuxSessionName: $tmuxSessionName} end)')"

  if ! api_call POST /api/dispatch/report "$payload"; then
    # **報告の失敗で処理を止めない。** issue-deckが単一障害点にならないようにする取り決め
    # （/api/progress と同じ）。報告が届かないジョブはissue-deck側のタイムアウトが拾う。
    report_api_failure "ジョブ状態の報告に失敗しました（$job_id → $status）"
  fi
}

tmux_session_names() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null | sort || true
}

# ジョブを1件実行する。
#
# 起動できたかどうかは、**起動の前後でtmuxのセッション一覧を比べて増分を見る**。
# セッション名の付け方は各リポジトリの start-issue.sh 側の裁量で、こちらで先読みして
# 組み立てると規約がずれた瞬間に「起動したのに失敗と報告する」誤判定になる。
run_job() {
  local job_json="$1"
  local job_id owner repo full_name issue_number
  job_id="$(printf '%s' "$job_json" | jq -r '.id')"
  full_name="$(printf '%s' "$job_json" | jq -r '.repositoryFullName')"
  issue_number="$(printf '%s' "$job_json" | jq -r '.issueNumber')"
  owner="${full_name%%/*}"
  repo="${full_name#*/}"

  echo "ジョブ $job_id: $full_name #$issue_number"

  # 受け取った値をサブPC側でも検証する（多層防御）。issue-deck側で検証済みでも、
  # ここが最後にパス・シェル引数として使う場所なので改めて確かめる。
  if ! local_session_validate_target "$owner" "$repo" "$issue_number" 2>/dev/null; then
    report_job "$job_id" failed "受け取った owner/repo/Issue番号が不正です: $full_name #$issue_number"
    return 0
  fi

  # 申告と実態がずれることはある（申告後にcloneを消した、git pullで版数が変わった等）。
  # **失敗の理由をジョブの結果として返す。** ここを省くと無人実行では何も起きないまま終わる。
  if ! local_repo_check "$full_name"; then
    report_job "$job_id" failed "$(local_repo_status_summary "$full_name")"
    return 0
  fi

  # 重複起動の防止（#1179）。同じIssueのtmuxセッションが既にあるなら起動しない。
  # issue-deck側のactiveKeyとは別の層で、**手元のターミナルから直接起動した分**まで拾える
  # （そちらはissue-deckにジョブとして残らないため、DB側の制約では防げない）。
  local before after new_sessions
  before="$(tmux_session_names)"
  if printf '%s\n' "$before" | grep -qx ".*-issue-$issue_number" 2>/dev/null; then
    local existing
    existing="$(printf '%s\n' "$before" | grep -x ".*-issue-$issue_number" | head -1)"
    report_job "$job_id" failed "同じIssueのtmuxセッションが既に動いています: $existing" "$existing"
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  --dry-run のため起動しません（$LOCAL_REPO_PATH）"
    return 0
  fi

  report_job "$job_id" running "起動しています（$LOCAL_REPO_PATH）"

  # 起動の出力は失敗時にジョブの結果として返すため取っておく。
  # stdinを閉じるのは、systemd配下には端末が無く、受け口の異常終了時の `read` 待ちへ
  # 落ちないようにするため。
  local output_file launch_status
  output_file="$(mktemp)"
  set +e
  bash "$LAUNCHER" "$owner" "$repo" "$issue_number" </dev/null >"$output_file" 2>&1
  launch_status=$?
  set -e

  after="$(tmux_session_names)"
  new_sessions="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -v '^$' || true)"

  if [[ -n "$new_sessions" ]]; then
    local session
    session="$(printf '%s\n' "$new_sessions" | head -1)"
    echo "  起動しました: tmuxセッション $session"
    report_job "$job_id" succeeded "tmuxセッション $session を起動しました" "$session"
  else
    # 起動の出力をそのまま返す。受け口は「何を直せばよいか」まで書いて止まるため、
    # 画面にそのまま出せば原因が分かる。
    local message
    message="$(tail -c 1500 "$output_file")"
    echo "  起動できませんでした（終了コード $launch_status）" >&2
    printf '%s\n' "$message" >&2
    report_job "$job_id" failed "起動できませんでした（終了コード $launch_status）: $message"
  fi
  rm -f "$output_file"
}

# --- 1巡 ----------------------------------------------------------------------
announce || exit 1

if [[ "$ANNOUNCE_ONLY" -eq 1 ]]; then
  exit 0
fi

claim_payload="$(jq -n --arg host "$HOST_NAME" --argjson maxJobs "$MAX_JOBS" \
  '{host: $host, maxJobs: $maxJobs}')"
if ! api_call POST /api/dispatch/claim "$claim_payload"; then
  report_api_failure "ジョブの取得に失敗しました"
  exit 1
fi

jobs_json="$API_RESPONSE_BODY"
job_count="$(printf '%s' "$jobs_json" | jq '.jobs | length')"
if [[ "$job_count" -eq 0 ]]; then
  echo "取得できるジョブはありません。"
  exit 0
fi

echo "$job_count 件のジョブを取得しました。"
while IFS= read -r job; do
  [[ -n "$job" ]] || continue
  run_job "$job"
done < <(printf '%s' "$jobs_json" | jq -c '.jobs[]')
