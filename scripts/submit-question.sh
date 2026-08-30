#!/usr/bin/env bash
# Codexの質問をissue-deckへ登録し、Issue詳細からの回答を待つ（#2579）。

set -euo pipefail

CONFIG_FILE="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
WAIT_SECONDS="${SESSION_QUESTION_WAIT_SECONDS:-300}"
POLL_INTERVAL="${SESSION_PLAN_POLL_INTERVAL_SECONDS:-3}"
POLL_GRACE_SECONDS="${SESSION_PLAN_POLL_GRACE_SECONDS:-60}"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/submit-question.sh <questions-json-file>

質問をissue-deckへ登録し、画面からの回答を待ちます。
質問ファイルはAskUserQuestionと同じquestions配列のJSONです。
終了コード: 0=回答（stdoutにanswers JSON）、2=端末で回答、3=期限切れ・通信失敗
EOF
}

[[ $# -eq 1 ]] || { usage; exit 1; }
QUESTIONS_FILE="$1"
[[ -s "$QUESTIONS_FILE" ]] || { echo "Error: 質問ファイルが無いか空です: $QUESTIONS_FILE" >&2; exit 1; }
[[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "Error: SESSION_QUESTION_WAIT_SECONDSは1以上の整数にしてください" >&2; exit 1; }
[[ "$POLL_INTERVAL" =~ ^[1-9][0-9]*$ ]] || { echo "Error: SESSION_PLAN_POLL_INTERVAL_SECONDSは1以上の整数にしてください" >&2; exit 1; }
[[ "$POLL_GRACE_SECONDS" =~ ^[0-9]+$ ]] || { echo "Error: SESSION_PLAN_POLL_GRACE_SECONDSは0以上の整数にしてください" >&2; exit 1; }

dispatch_env_value() {
  local name="$1"
  if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    (set +eu; source "$CONFIG_FILE" >/dev/null 2>&1; printf '%s' "${!name:-}")
    return 0
  fi
  printf '%s' "${!name:-}"
}

APP_BASE_URL="$(dispatch_env_value APP_BASE_URL)"
DISPATCH_SECRET="$(dispatch_env_value DISPATCH_SECRET)"
[[ -n "$APP_BASE_URL" && -n "$DISPATCH_SECRET" ]] || {
  echo "Error: APP_BASE_URL / DISPATCH_SECRET が見つかりません（$CONFIG_FILE）" >&2
  echo "       サブPCでは ~/.config/issue-deck/dispatch.env に両方を置いてください（deploy/subpc/dispatch.env.example 参照）。" >&2
  exit 1
}

REPOSITORY="${ISSUE_SESSION_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
if [[ -z "$REPOSITORY" ]]; then
  REMOTE_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
  REPOSITORY="$(printf '%s' "$REMOTE_URL" | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')"
fi
ISSUE_NUMBER="${ISSUE_SESSION_ISSUE_NUMBER:-}"
if [[ -z "$ISSUE_NUMBER" ]]; then
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  [[ "$BRANCH" =~ ^issue-([0-9]+)$ ]] && ISSUE_NUMBER="${BASH_REMATCH[1]}"
fi
[[ "$REPOSITORY" =~ ^[^/]+/[^/]+$ ]] || { echo "Error: リポジトリを特定できません" >&2; exit 1; }
[[ "$ISSUE_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo "Error: Issue番号を特定できません" >&2; exit 1; }

HOST_NAME="$(dispatch_env_value DISPATCH_HOST_NAME)"
[[ -n "$HOST_NAME" ]] || HOST_NAME="$(hostname -s 2>/dev/null || printf 'unknown')"

build_payload() {
  python3 - "$QUESTIONS_FILE" "$REPOSITORY" "$ISSUE_NUMBER" "$HOST_NAME" "$WAIT_SECONDS" <<'PY'
import json
import pathlib
import sys

questions_file, repository, issue, host_name, wait_seconds = sys.argv[1:]
try:
    questions = json.loads(pathlib.Path(questions_file).read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    print(f"Error: 質問ファイルをJSONとして読めません: {error}", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(questions, list) or not questions:
    print("Error: 質問ファイルは空でないJSON配列にしてください", file=sys.stderr)
    raise SystemExit(1)
print(json.dumps({
    "repository": repository,
    "issue": int(issue),
    "hostName": host_name,
    "questions": questions,
    "waitSeconds": int(wait_seconds),
}, ensure_ascii=False))
PY
}

json_field() {
  BODY="$1" KEY="$2" python3 -c '
import json, os
try:
    value = json.loads(os.environ["BODY"]).get(os.environ["KEY"])
except Exception:
    value = None
if isinstance(value, str):
    print(value, end="")
' 2>/dev/null || true
}

json_answers() {
  BODY="$1" python3 -c '
import json, os
try:
    value = json.loads(os.environ["BODY"]).get("answers")
except Exception:
    value = None
if isinstance(value, dict) and value:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
' 2>/dev/null || true
}

post_json() {
  local path="$1"
  curl -fsS --max-time 30 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $DISPATCH_SECRET" \
    --data-binary @- \
    "${APP_BASE_URL%/}$path" 2>/dev/null
}

get_json() {
  curl -fsS --max-time 10 \
    -H "Authorization: Bearer $DISPATCH_SECRET" \
    "${APP_BASE_URL%/}$1" 2>/dev/null
}

release_request() {
  local request_id="$1"
  [[ "$request_id" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  printf '{"id":"%s"}' "$request_id" | post_json /api/dispatch/sessions/question/decision
}

handle_decision() {
  local response="$1" status answers
  status="$(json_field "$response" status)"
  case "$status" in
    ANSWERED)
      answers="$(json_answers "$response")"
      [[ -n "$answers" ]] || { echo "Error: 質問の回答を解釈できませんでした" >&2; return 3; }
      printf '%s\n' "$answers"
      return 0
      ;;
    WAITING)
      return 1
      ;;
    DEFERRED)
      echo "質問への回答先が端末へ切り替えられました。端末でユーザーへ確認してください。" >&2
      return 2
      ;;
    EXPIRED|GONE)
      echo "質問の画面待機が終了しました。端末でユーザーへ確認してください（status: $status）" >&2
      return 3
      ;;
    *)
      echo "Error: 質問の判断を解釈できませんでした" >&2
      return 3
      ;;
  esac
}

if ! PAYLOAD="$(build_payload)"; then
  exit 3
fi
if ! RESPONSE="$(printf '%s' "$PAYLOAD" | post_json /api/dispatch/sessions/question)"; then
  echo "Error: 質問をissue-deckへ登録できませんでした" >&2
  exit 3
fi
REQUEST_ID="$(json_field "$RESPONSE" questionRequestId)"
[[ "$REQUEST_ID" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "Error: 質問の返事待ちを作れませんでした" >&2
  exit 3
}

echo "質問をissue-deckへ登録しました。Issue詳細からの回答を待っています。" >&2
DEADLINE=$((SECONDS + WAIT_SECONDS))
FAILED_SINCE=-1
while ((SECONDS < DEADLINE)); do
  if RESPONSE="$(get_json "/api/dispatch/sessions/question/decision?id=$REQUEST_ID")"; then
    FAILED_SINCE=-1
    set +e
    handle_decision "$RESPONSE"
    OUTCOME=$?
    set -e
    ((OUTCOME == 1)) || exit "$OUTCOME"
  else
    ((FAILED_SINCE < 0)) && FAILED_SINCE=$SECONDS
    if ((SECONDS - FAILED_SINCE >= POLL_GRACE_SECONDS)); then
      RESPONSE="$(release_request "$REQUEST_ID" 2>/dev/null || true)"
      if [[ -n "$RESPONSE" ]]; then
        set +e
        handle_decision "$RESPONSE"
        OUTCOME=$?
        set -e
        ((OUTCOME == 0)) && exit 0
      fi
      echo "Error: issue-deckとの通信失敗が${POLL_GRACE_SECONDS}秒続いたため、画面待機を終了しました" >&2
      exit 3
    fi
  fi
  sleep "$POLL_INTERVAL"
done

RESPONSE="$(release_request "$REQUEST_ID" 2>/dev/null || true)"
if [[ -n "$RESPONSE" ]]; then
  set +e
  handle_decision "$RESPONSE"
  OUTCOME=$?
  set -e
  ((OUTCOME == 0)) && exit 0
fi
echo "質問の回答待ちが${WAIT_SECONDS}秒で期限切れになりました。端末でユーザーへ確認してください。" >&2
exit 3
