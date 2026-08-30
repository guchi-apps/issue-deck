#!/usr/bin/env bash
# Codexの計画をissue-deckへ登録し、Issue詳細からの承認・修正を待つ（#2545）。

set -euo pipefail

CONFIG_FILE="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
WAIT_SECONDS="${SESSION_PLAN_WAIT_SECONDS:-1800}"
POLL_INTERVAL="${SESSION_PLAN_POLL_INTERVAL_SECONDS:-3}"
POLL_GRACE_SECONDS="${SESSION_PLAN_POLL_GRACE_SECONDS:-60}"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/submit-plan.sh <plan-file>

計画をissue-deckへ登録し、画面からの承認または修正を待ちます。
終了コード: 0=承認または修正依頼、3=期限切れ・通信失敗
EOF
}

[[ $# -eq 1 ]] || { usage; exit 1; }
PLAN_FILE="$1"
[[ -s "$PLAN_FILE" ]] || { echo "Error: 計画ファイルが無いか空です: $PLAN_FILE" >&2; exit 1; }
[[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "Error: SESSION_PLAN_WAIT_SECONDSは1以上の整数にしてください" >&2; exit 1; }
[[ "$POLL_INTERVAL" =~ ^[1-9][0-9]*$ ]] || { echo "Error: SESSION_PLAN_POLL_INTERVAL_SECONDSは1以上の整数にしてください" >&2; exit 1; }
[[ "$POLL_GRACE_SECONDS" =~ ^[0-9]+$ ]] || { echo "Error: SESSION_PLAN_POLL_GRACE_SECONDSは0以上の整数にしてください" >&2; exit 1; }

# 宛先と鍵は`session-notify.sh`・pollerと同じ`dispatch.env`から読む（#1264・#2551）。
#
# **`notify.env`からは読めない**（#2551）。あちらが持つのはSignalyのwebhook URLだけで、
# `deploy/subpc/notify.env.example`にも「報告先はdispatch.envから読む」と書いてある。
# #2545はここを`notify.env`から読んでいたため、実機では宛先が空のまま`exit 1`になり、
# Codexのセッションが計画の登録を諦めて`gh issue comment`へ落ちていた（＝画面に承認パネルが
# 出ない）。
#
# **環境変数だけにも頼らない。** pollerは`dispatch.env`を`set -a`で読んでから起動するが、
# tmuxのセッションが引き継ぐのはtmuxサーバー側の環境で、サーバーをいつ・誰が起こしたかで
# 届くかどうかが変わる（`build_env_prefix`が転送するのは`ISSUE_DECK_*`だけ）。
dispatch_env_value() {
  local name="$1"
  if [[ -f "$CONFIG_FILE" ]]; then
    # ファイルが定義していない値は、subshellが引き継いだ環境変数がそのまま出る
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
PLAN_BASE_SHA="$(git rev-parse origin/develop 2>/dev/null || git rev-parse origin/main 2>/dev/null || true)"

build_payload() {
  python3 - "$PLAN_FILE" "$REPOSITORY" "$ISSUE_NUMBER" "$HOST_NAME" "$WAIT_SECONDS" "$PLAN_BASE_SHA" <<'PY'
import json
import os
import pathlib
import sys

plan_file, repository, issue, host_name, wait_seconds, plan_base_sha = sys.argv[1:]
print(json.dumps({
    "repository": repository,
    "issue": int(issue),
    "hostName": host_name,
    "plan": pathlib.Path(plan_file).read_text(encoding="utf-8"),
    "waitSeconds": int(wait_seconds),
    "planBaseSha": plan_base_sha or None,
    "remoteControlUrl": None,
    "agent": os.environ.get("ISSUE_DECK_AGENT") if os.environ.get("ISSUE_DECK_AGENT") in ("claude", "codex") else "claude",
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

post_json() {
  local path="$1"
  curl -fsS --max-time 30 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $DISPATCH_SECRET" \
    --data-binary @- \
    "${APP_BASE_URL%/}$path" 2>/dev/null
}

report_delivery() {
  local request_id="$1" status="$2" exit_code="$3" summary="$4"
  # 結果本文は監査用の要約だけを保存し、計画や修正本文をDBへ複製しない
  summary="${summary:0:500}"
  python3 - "$request_id" "$status" "$exit_code" "$summary" <<'PY' | post_json /api/dispatch/sessions/plan/delivery >/dev/null
import json
import sys
print(json.dumps({"id": sys.argv[1], "status": sys.argv[2], "exitCode": int(sys.argv[3]), "summary": sys.argv[4]}, ensure_ascii=False))
PY
}

report_delivery_best_effort() {
  if ! report_delivery "$@"; then
    echo "Warning: 計画の処理結果をissue-deckへ報告できませんでした（id: $1）" >&2
  fi
}

get_json() {
  curl -fsS --max-time 10 \
    -H "Authorization: Bearer $DISPATCH_SECRET" \
    "${APP_BASE_URL%/}$1" 2>/dev/null
}

release_request() {
  local request_id="$1"
  [[ "$request_id" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  printf '{"id":"%s"}' "$request_id" | post_json /api/dispatch/sessions/plan/decision
}

handle_decision() {
  local response="$1" status revision
  status="$(json_field "$response" status)"
  case "$status" in
    APPROVED)
      echo "計画がissue-deckの画面で承認されました。実装へ進んでください。"
      return 0
      ;;
    REVISION_REQUESTED)
      revision="$(json_field "$response" revisionText)"
      # Codexは終了コードが0以外のコマンドを失敗として扱い、失敗したコマンドの出力を
      # 次の計画作成へ使わないことがある。修正本文を標準出力へ出し、成功した対話結果として
      # 返すことで、画面から送った修正を確実に次の計画へ反映させる。
      echo "計画の修正が求められました。次の内容を反映して計画を再送してください。"
      printf '%s\n' "${revision:-（修正内容を取得できませんでした）}"
      return 0
      ;;
    WAITING)
      return 1
      ;;
    DEFERRED|EXPIRED|GONE)
      echo "計画の画面待機が終了しました。端末で承認を確認してください（status: $status）" >&2
      return 3
      ;;
    *)
      echo "Error: 計画の判断を解釈できませんでした" >&2
      return 3
      ;;
  esac
}

if ! RESPONSE="$(build_payload | post_json /api/dispatch/sessions/plan)"; then
  echo "Error: 計画をissue-deckへ登録できませんでした" >&2
  exit 3
fi
REQUEST_ID="$(json_field "$RESPONSE" planRequestId)"
[[ "$REQUEST_ID" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "Error: 計画の返事待ちを作れませんでした" >&2
  exit 3
}

echo "計画をissue-deckへ登録しました。Issue詳細からの承認・修正を待っています。" >&2
DEADLINE=$((SECONDS + WAIT_SECONDS))
FAILED_SINCE=-1
while ((SECONDS < DEADLINE)); do
  if RESPONSE="$(get_json "/api/dispatch/sessions/plan/decision?id=$REQUEST_ID")"; then
    FAILED_SINCE=-1
    set +e
    DECISION_OUTPUT="$(handle_decision "$RESPONSE")"
    OUTCOME=$?
    set -e
    if ((OUTCOME != 1)); then
      printf '%s\n' "$DECISION_OUTPUT"
      if ((OUTCOME == 0)); then
        report_delivery_best_effort "$REQUEST_ID" PROCESSED 0 "$DECISION_OUTPUT"
      else
        report_delivery_best_effort "$REQUEST_ID" PROCESS_FAILED "$OUTCOME" "$DECISION_OUTPUT"
      fi
    fi
    ((OUTCOME == 1)) || exit "$OUTCOME"
  else
    ((FAILED_SINCE < 0)) && FAILED_SINCE=$SECONDS
    if ((SECONDS - FAILED_SINCE >= POLL_GRACE_SECONDS)); then
      RESPONSE="$(release_request "$REQUEST_ID" 2>/dev/null || true)"
      if [[ -n "$RESPONSE" ]]; then
        set +e
        DECISION_OUTPUT="$(handle_decision "$RESPONSE")"
        OUTCOME=$?
        set -e
        printf '%s\n' "$DECISION_OUTPUT"
        if ((OUTCOME == 0)); then
          report_delivery_best_effort "$REQUEST_ID" PROCESSED 0 "$DECISION_OUTPUT"
        else
          # GETが連続失敗した後の解除応答なので、セッション処理ではなく通信経路の失敗として残す
          report_delivery_best_effort "$REQUEST_ID" COMMUNICATION_FAILED "$OUTCOME" "$DECISION_OUTPUT"
        fi
        ((OUTCOME == 3)) || exit "$OUTCOME"
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
  DECISION_OUTPUT="$(handle_decision "$RESPONSE")"
  OUTCOME=$?
  set -e
  printf '%s\n' "$DECISION_OUTPUT"
  if ((OUTCOME == 0)); then
    report_delivery_best_effort "$REQUEST_ID" PROCESSED 0 "$DECISION_OUTPUT"
  else
    report_delivery_best_effort "$REQUEST_ID" PROCESS_FAILED "$OUTCOME" "$DECISION_OUTPUT"
  fi
  ((OUTCOME == 3)) || exit "$OUTCOME"
fi
echo "計画の承認待ちが${WAIT_SECONDS}秒で期限切れになりました。端末で承認を確認してください。" >&2
exit 3
