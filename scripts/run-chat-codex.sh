#!/usr/bin/env bash
# チャット相談のモデル呼び出し1回ぶん（`DispatchJob.kind = CHAT_TURN`・#4109）を、サブPCの
# ログイン済みCodex CLI（ChatGPT/Codexのサブスク枠）で実行して、結果をissue-deckへ返す。
#
#   scripts/run-chat-codex.sh <ジョブID>
#
# 呼ぶのはpoller（`run_chat_turn_job`）で、バックグラウンドで起こして待たない（巡回を止めないため）。
#
# **OpenAI APIは使わない。** `codex login status`がChatGPTアカウントでのログインを示さなければ
# 実行せずに失敗を返す（APIキーでのログインは従量課金になるため`api_key_auth`として断る）。
#
# **読み取り専用で、リポジトリにもホームにも触れない。** 作業ディレクトリは毎回作る空の一時
# ディレクトリで、`--sandbox read-only --ephemeral --skip-git-repo-check`で起こす。プロンプトは
# issue-deckの調査ループが組み立てたもので、ツールの実行（DB・GitHubの読み取り）はサーバー側が行う。
#
# 認証情報（`APP_BASE_URL`・`DISPATCH_SECRET`・`DISPATCH_HOST_NAME`）はpollerの環境か
# `~/.config/issue-deck/dispatch.env`から取る（`lib/pr-review-report.sh`と同じ）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/agent-cli.sh
source "$SCRIPT_DIR/lib/agent-cli.sh"
# shellcheck source=scripts/lib/review-usage.sh
source "$SCRIPT_DIR/lib/review-usage.sh"

JOB_ID="${1:-}"
TIMEOUT_SECONDS="${ISSUE_DECK_CHAT_CODEX_TIMEOUT_SECONDS:-110}"

if [[ ! "$JOB_ID" =~ ^[a-z0-9]{8,32}$ ]]; then
  echo "Usage: scripts/run-chat-codex.sh <ジョブID>" >&2
  exit 2
fi

APP_BASE_URL_VALUE="$(_review_usage_env_value APP_BASE_URL)"
DISPATCH_SECRET_VALUE="$(_review_usage_env_value DISPATCH_SECRET)"
HOST_NAME_VALUE="$(_review_usage_env_value DISPATCH_HOST_NAME)"
[[ -n "$HOST_NAME_VALUE" ]] || HOST_NAME_VALUE="$(hostname -s 2>/dev/null || printf 'unknown')"
if [[ -z "$APP_BASE_URL_VALUE" || -z "$DISPATCH_SECRET_VALUE" ]]; then
  echo "APP_BASE_URL / DISPATCH_SECRET が設定されていません。" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/issue-deck-chat-codex.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR/cwd"

# シークレットはコマンドライン引数に置かない（`ps`で見えるため）
chat_api() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(--silent --show-error --max-time 30 --request "$method" --header @-
    --write-out '%{http_code}' --output "$WORK_DIR/response.json")
  if [[ -n "$body" ]]; then
    args+=(--header 'Content-Type: application/json' --data-binary "$body")
  fi
  printf 'Authorization: Bearer %s\n' "$DISPATCH_SECRET_VALUE" |
    curl "${args[@]}" "${APP_BASE_URL_VALUE%/}${path}"
}

# report <succeeded|failed> [errorKind] [出力ファイル] [usage JSON]
report() {
  local status="$1" error_kind="${2:-}" output_file="${3:-}" usage="${4:-null}" body code
  body="$(jq -nc --arg jobId "$JOB_ID" --arg host "$HOST_NAME_VALUE" --arg status "$status" \
    --arg errorKind "$error_kind" --rawfile output "${output_file:-/dev/null}" --argjson usage "$usage" \
    '{jobId: $jobId, host: $host, status: $status, usage: $usage}
      + (if $errorKind == "" then {} else {errorKind: $errorKind} end)
      + (if $output == "" then {} else {output: $output} end)')"
  code="$(chat_api POST /api/dispatch/chat-turn "$body" || true)"
  echo "結果を報告しました（$status${error_kind:+ / $error_kind}・HTTP $code）"
}

CODEX="$(agent_cli_codex_command)"
if ! command -v "$CODEX" >/dev/null 2>&1; then
  report failed codex_error
  exit 0
fi

# ChatGPTアカウントでのログインだけを使う。APIキーのログインは従量課金になるので断る
login_status="$("$CODEX" login status 2>&1 || true)"
if grep -qi 'api key' <<<"$login_status"; then
  report failed api_key_auth
  exit 0
fi
if ! grep -qi 'chatgpt' <<<"$login_status"; then
  report failed not_logged_in
  exit 0
fi

code="$(chat_api GET "/api/dispatch/chat-turn?jobId=$JOB_ID&host=$(jq -rn --arg h "$HOST_NAME_VALUE" '$h|@uri')" || true)"
if [[ "$code" != "200" ]]; then
  # 待つ側が既に諦めた（取り消し済み）などで受け取れない。報告先も無いので終える
  echo "プロンプトを受け取れませんでした（HTTP $code）。" >&2
  exit 0
fi
model="$(jq -r '.model // ""' "$WORK_DIR/response.json")"
jq -r '.prompt // ""' "$WORK_DIR/response.json" >"$WORK_DIR/prompt.md"
jq -c '.schema' "$WORK_DIR/response.json" >"$WORK_DIR/schema.json"
if [[ ! "$model" =~ ^gpt-[a-z0-9.-]+$ || ! -s "$WORK_DIR/prompt.md" ]]; then
  report failed codex_error
  exit 0
fi

exit_code=0
timeout "$TIMEOUT_SECONDS" "$CODEX" exec --json --skip-git-repo-check --sandbox read-only --ephemeral \
  -m "$model" --output-schema "$WORK_DIR/schema.json" --output-last-message "$WORK_DIR/out.json" \
  -C "$WORK_DIR/cwd" - <"$WORK_DIR/prompt.md" >"$WORK_DIR/events.jsonl" 2>"$WORK_DIR/stderr.log" || exit_code=$?

if [[ "$exit_code" -eq 124 ]]; then
  report failed timeout
  exit 0
fi
if [[ "$exit_code" -ne 0 || ! -s "$WORK_DIR/out.json" ]]; then
  # 失敗の文言から原因を分ける（利用枠・認証）。分からなければ汎用の失敗
  failure_text="$(cat "$WORK_DIR/stderr.log" "$WORK_DIR/events.jsonl" 2>/dev/null | tail -c 20000)"
  if grep -Eqi 'usage limit|usage_limit|rate.?limit|quota|429' <<<"$failure_text"; then
    report failed usage_limit
  elif grep -Eqi '401|unauthori[sz]ed|not logged in|log ?in again|refresh token' <<<"$failure_text"; then
    report failed not_logged_in
  elif [[ "$exit_code" -eq 0 ]]; then
    report failed bad_output
  else
    report failed codex_error
  fi
  printf '%s\n' "$failure_text" | tail -20 >&2
  exit 0
fi

usage="$(jq -c 'select(.type == "turn.completed") | .usage' "$WORK_DIR/events.jsonl" 2>/dev/null | tail -1)"
report succeeded "" "$WORK_DIR/out.json" "${usage:-null}"
