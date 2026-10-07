#!/usr/bin/env bash
# サブPCからSSHでMac miniへiOSの事前検証（ビルド／自動テスト）を依頼する（#4138）。
#
# XcodeのないサブPCで実装したiOS変更を、レビュー前にMacでビルドしておくための経路。
# Claude Code・Codexのどちらのセッションからも同じコマンドを打ち、同じJSONを受け取る。
#
#   scripts/ios-precheck.sh run    [--repo owner/repo] [--sha SHA] [--kind build|test] [--repo-dir DIR]
#                                  [--no-wait] [--no-status] [--retry] [--wait-timeout SEC]
#   scripts/ios-precheck.sh status --job JOB_ID [--wait] [--repo owner/repo]
#   scripts/ios-precheck.sh cancel --job JOB_ID
#   scripts/ios-precheck.sh log    --job JOB_ID [--lines N]
#   scripts/ios-precheck.sh config [--repo owner/repo]
#   scripts/ios-precheck.sh doctor
#
# 標準出力には結果のJSONだけを出す（進み具合は標準エラーへ）。契約は
# docs/multi-agent/ios-precheck.md を正とする。
#
# 終了コード: 0 = 成功 / 1 = 検証失敗（ビルド・テスト） / 2 = 検証待ち（未設定・接続不可・
# 環境不足・タイムアウト・切断・中止・実行中のまま待ちを打ち切った） / 64 = 使い方の誤り
#
# 設計の要点:
# - ソースは`git archive <SHA>`のtarで送る。Macの普段の作業ツリーを切り替えず、Mac側に
#   GitHubの資格情報も要らない。検証したSHAはMac側がtarのヘッダから読み直す
# - ジョブIDは`<repo名>-<SHA先頭12桁>-<種別>`で決まる。同じ依頼を何度送っても1回しか走らず、
#   2回目以降は今の状態を返す。やり直したいときだけ`--retry`で別IDにする
# - 結果はSHAへcommit status（`issue-deck/ios-precheck`）として出す。statusはコミットに付くので、
#   修正をpushした新しいSHAには前の成功が引き継がれない
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_RUNNER="$SCRIPT_DIR/lib/ios-precheck-remote.sh"
CONFIG_FILE="${ISSUE_DECK_IOS_PRECHECK_CONFIG:-$SCRIPT_DIR/ios-precheck.conf}"
HOST_ENV_FILE="${ISSUE_DECK_IOS_PRECHECK_ENV:-$HOME/.config/issue-deck/ios-precheck.env}"
STATE_DIR="${ISSUE_DECK_IOS_PRECHECK_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck/ios-precheck}"
STATUS_CONTEXT="issue-deck/ios-precheck"
# 同じブランチで「検証失敗→修正」を繰り返してよい回数。超えたら直すのをやめて人へ渡す
MAX_FIX_ATTEMPTS="${IOS_PRECHECK_MAX_FIX_ATTEMPTS:-3}"
POLL_INTERVAL="${IOS_PRECHECK_POLL_INTERVAL:-15}"
# 状態の取得が続けて失敗したら切断とみなす回数
MAX_POLL_FAILURES="${IOS_PRECHECK_MAX_POLL_FAILURES:-4}"
SSH_BIN="${IOS_PRECHECK_SSH:-ssh}"
# Mac側の置き場所。`$HOME`はMac側のシェルで展開させる
# shellcheck disable=SC2016
REMOTE_ROOT='$HOME/.issue-deck/ios-precheck'

log() { printf '[ios-precheck] %s\n' "$*" >&2; }
die_usage() {
  printf '%s\n' "$*" >&2
  exit 64
}

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------

# `[owner/repo]`の区間から key=value を `C_<key>` 変数へ読み込む。載っていなければ非0
CFG_KEYS=(project workspace scheme simulator simulator_os tests test_plan kind required build_timeout test_timeout)
load_repo_config() {
  local repo="$1" line in_section=0 found=1 key value k
  for k in "${CFG_KEYS[@]}"; do printf -v "C_$k" '%s' ""; done
  [ -f "$CONFIG_FILE" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ "$line" =~ ^\[(.+)\][[:space:]]*$ ]]; then
      if [ "${BASH_REMATCH[1]}" = "$repo" ]; then
        in_section=1
        found=0
      else
        in_section=0
      fi
      continue
    fi
    [ "$in_section" = 1 ] || continue
    [[ "$line" =~ ^[[:space:]]*([a-z_]+)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    for k in "${CFG_KEYS[@]}"; do
      if [ "$k" = "$key" ]; then printf -v "C_$k" '%s' "$value"; fi
    done
  done <"$CONFIG_FILE"
  [ "$found" = 0 ] || return 1
  : "${C_tests:=none}" "${C_kind:=build}" "${C_required:=false}"
  : "${C_build_timeout:=1800}" "${C_test_timeout:=1800}"
  return 0
}

# 設定の欠けを1行ずつ返す（空なら問題なし）
config_problems() {
  [ -n "$C_scheme" ] || echo "scheme が未設定です"
  [ -n "$C_simulator" ] || echo "simulator が未設定です"
  if [ -z "$C_project" ] && [ -z "$C_workspace" ]; then echo "project か workspace のどちらかが必要です"; fi
  if [ -n "$C_project" ] && [ -n "$C_workspace" ]; then echo "project と workspace は片方だけ書きます"; fi
  case "$C_tests" in none | scheme) ;; *) echo "tests は none か scheme です（$C_tests）" ;; esac
  case "$C_kind" in build | test) ;; *) echo "kind は build か test です（$C_kind）" ;; esac
  case "$C_required" in true | false) ;; *) echo "required は true か false です（$C_required）" ;; esac
  [[ "$C_build_timeout" =~ ^[0-9]+$ ]] || echo "build_timeout は秒数です"
  [[ "$C_test_timeout" =~ ^[0-9]+$ ]] || echo "test_timeout は秒数です"
}

# 接続先。**環境変数かサブPCの設定ファイルからだけ読む**（公開リポジトリに書かない）。
# 設定ファイルは`source`しない（任意のコードを実行させない）
resolve_host() {
  if [ -n "${IOS_PRECHECK_HOST:-}" ]; then
    printf '%s' "$IOS_PRECHECK_HOST"
    return 0
  fi
  [ -f "$HOST_ENV_FILE" ] || return 1
  local value
  value="$(sed -n 's/^[[:space:]]*IOS_PRECHECK_HOST=//p' "$HOST_ENV_FILE" | tail -n 1)"
  value="${value%\"}"
  value="${value#\"}"
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# originのURLから owner/repo を取り出す
repo_from_remote() {
  local dir="$1" url
  url="$(git -C "$dir" remote get-url origin 2>/dev/null)" || return 1
  url="${url%.git}"
  [[ "$url" =~ github\.com[:/]+([^/]+/[^/]+)$ ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}

# ---------------------------------------------------------------------------
# 結果
# ---------------------------------------------------------------------------

# Mac側に届く前に決まった「検証待ち」を、Mac側と同じ形のJSONで作る
local_waiting_json() {
  local job_id="$1" repo="$2" sha="$3" kind="$4" reason="$5" message="$6"
  jq -cn --arg jobId "$job_id" --arg repo "$repo" --arg sha "$sha" --arg kind "$kind" \
    --arg reason "$reason" --arg message "$message" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
      schemaVersion: 1, jobId: (if $jobId == "" then null else $jobId end), repository: $repo,
      requestedSha: (if $sha == "" then null else $sha end), verifiedSha: null, kind: $kind,
      state: "waiting", waitingReason: $reason, failedStage: null, message: $message,
      build: {status: "not_run", exitCode: null},
      test: {status: "not_run", exitCode: null, total: null, passed: null, failed: null, skipped: null},
      environment: {xcode: null, simulator: null},
      submittedAt: $now, startedAt: null, finishedAt: null, artifacts: null
    }'
}

# 次にどうするか。**環境の問題でソースを直しに行かせない**のがこの関数の役目
next_action_for() {
  local state="$1" reason="$2" attempts="$3"
  case "$state" in
    succeeded) printf 'proceed' ;;
    failed)
      if [ "$attempts" -ge "$MAX_FIX_ATTEMPTS" ]; then printf 'stop_fix_limit'; else printf 'fix_and_recheck'; fi
      ;;
    waiting)
      case "$reason" in
        not_configured) printf 'not_configured' ;;
        disconnected | wait_timeout) printf 'resume' ;;
        timeout | interrupted | queue_timeout) printf 'retry_or_report' ;;
        cancelled) printf 'none' ;;
        *) printf 'resolve_environment' ;;
      esac
      ;;
    *) printf 'resume' ;;
  esac
}

# 同じブランチで検証失敗になったSHAの数（修正の試行回数）
count_fix_attempts() {
  local repo="$1" branch="$2"
  [ -f "$STATE_DIR/history.tsv" ] || {
    printf '0'
    return
  }
  awk -F'\t' -v r="$repo" -v b="$branch" '$1 == r && $2 == b && $5 == "failed" { seen[$3] = 1 }
    END { n = 0; for (k in seen) n++; print n }' "$STATE_DIR/history.tsv"
}

# Mac側のJSONへ依頼側の情報（次の動作・再開コマンド・必須か）を足して出す
emit_result() {
  local json="$1" repo="$2" branch="$3" required="$4" state reason attempts action job_id
  state="$(jq -r '.state // ""' <<<"$json")"
  reason="$(jq -r '.waitingReason // ""' <<<"$json")"
  job_id="$(jq -r '.jobId // ""' <<<"$json")"
  attempts="$(count_fix_attempts "$repo" "$branch")"
  action="$(next_action_for "$state" "$reason" "$attempts")"
  local resume=""
  [ -n "$job_id" ] && resume="$SCRIPT_DIR/ios-precheck.sh status --job $job_id --wait --repo $repo"
  jq -c --arg action "$action" --arg branch "$branch" --argjson attempts "$attempts" \
    --argjson max "$MAX_FIX_ATTEMPTS" --arg resume "$resume" --argjson required "$required" '
    . + {client: {
      branch: (if $branch == "" then null else $branch end),
      required: $required,
      nextAction: $action,
      fixAttempts: $attempts,
      maxFixAttempts: $max,
      resumeCommand: (if $resume == "" then null else $resume end)
    }}' <<<"$json"
}

record_history() {
  local json="$1" repo="$2" branch="$3" job_id sha state
  mkdir -p "$STATE_DIR/results"
  job_id="$(jq -r '.jobId // ""' <<<"$json")"
  sha="$(jq -r '.requestedSha // ""' <<<"$json")"
  state="$(jq -r '.state // ""' <<<"$json")"
  [ -n "$job_id" ] || return 0
  printf '%s\n' "$json" >"$STATE_DIR/results/$job_id.json"
  # 依頼した時点（queued）の行も残す。`status --job`で再接続したときにブランチを引き直すため
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$repo" "$branch" "$sha" "$job_id" "$state" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$STATE_DIR/history.tsv"
}

# commit statusへ写す。**pending以外の成功・失敗はMacの結果からしか出さない**
status_for() {
  local state="$1" reason="$2" message="$3"
  case "$state" in
    succeeded) printf 'success\t%s' "$message" ;;
    failed) printf 'failure\t%s' "$message" ;;
    queued) printf 'pending\tiOS検証待ち（Macのキュー待ち）' ;;
    preparing) printf 'pending\tiOS検証: 準備中' ;;
    building) printf 'pending\tiOS検証: ビルド中' ;;
    testing) printf 'pending\tiOS検証: テスト中' ;;
    waiting) printf 'pending\tiOS検証待ち（%s）: %s' "$reason" "$message" ;;
    *) printf 'pending\tiOS検証待ち' ;;
  esac
}

POST_STATUS=1
post_status() {
  local repo="$1" sha="$2" state="$3" reason="$4" message="$5"
  [ "$POST_STATUS" = 1 ] || return 0
  [ -n "$sha" ] || return 0
  local line gh_state description
  line="$(status_for "$state" "$reason" "$message")"
  gh_state="${line%%$'\t'*}"
  description="${line#*$'\t'}"
  # GitHubのdescriptionは140文字まで
  description="${description:0:139}"
  if ! gh api -X POST "repos/$repo/statuses/$sha" -f state="$gh_state" -f context="$STATUS_CONTEXT" \
    -f description="$description" >/dev/null 2>&1; then
    log "commit statusを付けられませんでした（SHAがまだpushされていない可能性があります）。結果はこの出力を正としてください"
  fi
}

# ---------------------------------------------------------------------------
# SSH
# ---------------------------------------------------------------------------
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
SSH_ERR=""

# 失敗したら非0で返り、理由を`SSH_ERR`へ入れる（unreachable / host_key / auth）
remote() {
  local host="$1" err rc
  shift
  err="$(mktemp)"
  set +e
  "$SSH_BIN" "${SSH_OPTS[@]}" "$host" "$@" 2>"$err"
  rc=$?
  set -e
  SSH_ERR=""
  if [ "$rc" = 255 ]; then
    if grep -q "Host key verification failed\|REMOTE HOST IDENTIFICATION HAS CHANGED" "$err"; then
      SSH_ERR="host_key"
    elif grep -q "Permission denied" "$err"; then
      SSH_ERR="auth"
    else
      SSH_ERR="unreachable"
    fi
  elif [ "$rc" != 0 ]; then
    sed 's/^/[mac] /' "$err" >&2
  fi
  rm -f "$err"
  return "$rc"
}

ssh_reason_message() {
  case "$1" in
    host_key) printf 'Macのホスト鍵がknown_hostsと一致しません（鍵を照合してから known_hosts を更新してください）' ;;
    auth) printf 'MacへのSSH認証に失敗しました（鍵の登録を確認してください）' ;;
    *) printf 'Macに接続できません（電源・Tailscale・Remote Loginを確認してください）' ;;
  esac
}

RUNNER_REMOTE=""
# 実行体を送り込む。**内容のハッシュを名前に入れてmvで置く**——走っているジョブが読んでいる
# ファイルを上書きすると、bashが途中から別の中身を読んでしまうため
install_runner() {
  local host="$1" hash
  hash="$(sha256sum "$REMOTE_RUNNER" | cut -c1-12)"
  RUNNER_REMOTE="$REMOTE_ROOT/bin/runner-$hash.sh"
  remote "$host" "mkdir -p $REMOTE_ROOT/bin && if [ ! -f $RUNNER_REMOTE ]; then cat > $RUNNER_REMOTE.tmp.\$\$ && mv -f $RUNNER_REMOTE.tmp.\$\$ $RUNNER_REMOTE; else cat >/dev/null; fi" \
    <"$REMOTE_RUNNER"
}

runner() {
  local host="$1" arg quoted=""
  shift
  for arg in "$@"; do quoted+=" $(printf '%q' "$arg")"; done
  remote "$host" "bash $RUNNER_REMOTE$quoted"
}

# ---------------------------------------------------------------------------
# サブコマンド
# ---------------------------------------------------------------------------

# 状態を取り直し、終わるまで待つ。標準出力へ最終のJSONを1行出す
wait_for_job() {
  local host="$1" job_id="$2" repo="$3" sha="$4" kind="$5" wait_timeout="$6" json state="" last_state=""
  local failures=0 elapsed=0
  while :; do
    if json="$(runner "$host" status "$job_id")"; then
      failures=0
      json="$(tail -n 1 <<<"$json")"
      state="$(jq -r '.state // ""' <<<"$json" 2>/dev/null || true)"
      if [ "$state" != "$last_state" ]; then
        log "状態: $state"
        post_status "$repo" "$sha" "$state" "$(jq -r '.waitingReason // ""' <<<"$json")" \
          "$(jq -r '.message // ""' <<<"$json")"
        last_state="$state"
      fi
      case "$state" in
        succeeded | failed | waiting)
          printf '%s\n' "$json"
          return 0
          ;;
        unknown)
          local_waiting_json "$job_id" "$repo" "$sha" "$kind" "unknown_job" "Macにこのジョブの記録がありません"
          return 0
          ;;
      esac
    else
      failures=$((failures + 1))
      log "Macから状態を取得できませんでした（$failures/$MAX_POLL_FAILURES）"
      if [ "$failures" -ge "$MAX_POLL_FAILURES" ]; then
        # ジョブはMac側で走り続けている。成功にも失敗にもせず、再開方法を返す
        local_waiting_json "$job_id" "$repo" "$sha" "$kind" "disconnected" \
          "Macとの接続が切れました。Mac側の実行は続いているため、status --job で再開できます"
        return 0
      fi
    fi
    if [ "$elapsed" -ge "$wait_timeout" ]; then
      local_waiting_json "$job_id" "$repo" "$sha" "$kind" "wait_timeout" \
        "${wait_timeout}秒待っても終わりませんでした（最後の状態: ${state:-不明}）。status --job で再開できます"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
}

exit_code_for() {
  case "$(jq -r '.state // ""' <<<"$1")" in
    succeeded) return 0 ;;
    failed) return 1 ;;
    *) return 2 ;;
  esac
}

finalize() {
  local json="$1" repo="$2" branch="$3" required="$4" host="${5:-}"
  local state job_id
  state="$(jq -r '.state // ""' <<<"$json")"
  job_id="$(jq -r '.jobId // ""' <<<"$json")"
  record_history "$json" "$repo" "$branch"
  local out
  out="$(emit_result "$json" "$repo" "$branch" "$required")"
  printf '%s\n' "$out"
  log "結果: $(jq -r '"\(.state) / build=\(.build.status) / test=\(.test.status)\(if .test.total != null then " (\(.test.passed)/\(.test.total))" else "" end) / next=\(.client.nextAction)"' <<<"$out")"
  log "$(jq -r '.message' <<<"$out")"
  if [ "$state" = failed ] && [ -n "$host" ] && [ -n "$job_id" ]; then
    log "失敗箇所（Macのログから抜粋）:"
    runner "$host" log "$job_id" 60 >&2 || true
  fi
  exit_code_for "$json"
}

cmd_run() {
  local repo="" sha="" kind="" repo_dir="" wait=1 retry=0 wait_timeout=3600
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:?}"; shift 2 ;;
      --sha) sha="${2:?}"; shift 2 ;;
      --kind) kind="${2:?}"; shift 2 ;;
      --repo-dir) repo_dir="${2:?}"; shift 2 ;;
      --no-wait) wait=0; shift ;;
      --no-status) POST_STATUS=0; shift ;;
      --retry) retry=1; shift ;;
      --wait-timeout) wait_timeout="${2:?}"; shift 2 ;;
      *) die_usage "unknown option: $1" ;;
    esac
  done
  repo_dir="${repo_dir:-$PWD}"
  git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1 || die_usage "$repo_dir はgitリポジトリではありません（--repo-dir で指定してください）"
  if [ -z "$repo" ]; then
    repo="$(repo_from_remote "$repo_dir")" || die_usage "--repo を指定してください"
  fi
  local branch
  branch="$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ "$branch" = HEAD ] && branch=""

  if ! load_repo_config "$repo"; then
    finalize "$(local_waiting_json "" "$repo" "$sha" "${kind:-build}" "not_configured" \
      "$repo はiOS事前検証の対象に設定されていません（scripts/ios-precheck.conf）")" "$repo" "$branch" false
    return $?
  fi
  local required=false
  [ "$C_required" = true ] && required=true
  local problems
  problems="$(config_problems)"
  if [ -n "$problems" ]; then
    finalize "$(local_waiting_json "" "$repo" "$sha" "${kind:-build}" "not_configured" \
      "設定に誤りがあります: $(tr '\n' ' ' <<<"$problems")")" "$repo" "$branch" "$required"
    return $?
  fi
  kind="${kind:-$C_kind}"
  case "$kind" in build | test) ;; *) die_usage "--kind は build か test です" ;; esac

  sha="$(git -C "$repo_dir" rev-parse --verify "${sha:-HEAD}^{commit}" 2>/dev/null)" ||
    die_usage "コミットが見つかりません: ${sha:-HEAD}"
  if [ -n "$(git -C "$repo_dir" status --porcelain 2>/dev/null)" ]; then
    log "注意: 未コミットの変更は検証に含まれません（検証するのは $sha のコミットです）"
  fi

  local job_id="${repo##*/}-${sha:0:12}-$kind"
  [ "$retry" = 1 ] && job_id="$job_id-r$(date +%s)"

  local host
  if ! host="$(resolve_host)"; then
    finalize "$(local_waiting_json "$job_id" "$repo" "$sha" "$kind" "environment" \
      "接続先が未設定です（$HOST_ENV_FILE に IOS_PRECHECK_HOST=<ssh先> を書きます）")" "$repo" "$branch" "$required"
    return $?
  fi

  post_status "$repo" "$sha" queued "" ""
  log "$repo@${sha:0:12} の検証（$kind）をMacへ依頼します（ジョブID: $job_id）"
  if ! install_runner "$host"; then
    local reason="${SSH_ERR:-unreachable}"
    local json
    json="$(local_waiting_json "$job_id" "$repo" "$sha" "$kind" "$reason" "$(ssh_reason_message "$reason")")"
    post_status "$repo" "$sha" waiting "$reason" "$(ssh_reason_message "$reason")"
    finalize "$json" "$repo" "$branch" "$required"
    return $?
  fi

  local -a args=(submit "id=$job_id" "repo=$repo" "sha=$sha" "kind=$kind" "scheme=$C_scheme"
    "simulator=$C_simulator" "tests=$C_tests" "build_timeout=$C_build_timeout" "test_timeout=$C_test_timeout")
  [ -n "$C_project" ] && args+=("project=$C_project")
  [ -n "$C_workspace" ] && args+=("workspace=$C_workspace")
  [ -n "$C_simulator_os" ] && args+=("simulator_os=$C_simulator_os")
  [ -n "$C_test_plan" ] && args+=("test_plan=$C_test_plan")

  local submitted
  if ! submitted="$(git -C "$repo_dir" archive --format=tar "$sha" | runner "$host" "${args[@]}")"; then
    local reason="${SSH_ERR:-transfer}" json
    json="$(local_waiting_json "$job_id" "$repo" "$sha" "$kind" "$reason" \
      "Macへの依頼に失敗しました。$(ssh_reason_message "$reason")")"
    post_status "$repo" "$sha" waiting "$reason" "Macへの依頼に失敗しました"
    finalize "$json" "$repo" "$branch" "$required"
    return $?
  fi
  if [ "$(head -n 1 <<<"$submitted")" = DUPLICATE ]; then
    log "同じジョブIDの依頼が既にあります。新しく実行せず、その結果を待ちます（やり直すときは --retry）"
  fi
  local json
  json="$(tail -n 1 <<<"$submitted")"

  if [ "$wait" = 0 ]; then
    record_history "$json" "$repo" "$branch"
    emit_result "$json" "$repo" "$branch" "$required"
    return 2
  fi
  json="$(wait_for_job "$host" "$job_id" "$repo" "$sha" "$kind" "$wait_timeout")"
  finalize "$json" "$repo" "$branch" "$required" "$host"
}

cmd_status() {
  local job_id="" wait=0 repo="" wait_timeout=3600
  while [ $# -gt 0 ]; do
    case "$1" in
      --job) job_id="${2:?}"; shift 2 ;;
      --wait) wait=1; shift ;;
      --repo) repo="${2:?}"; shift 2 ;;
      --no-status) POST_STATUS=0; shift ;;
      --wait-timeout) wait_timeout="${2:?}"; shift 2 ;;
      *) die_usage "unknown option: $1" ;;
    esac
  done
  [ -n "$job_id" ] || die_usage "--job を指定してください"
  local host
  host="$(resolve_host)" || die_usage "接続先が未設定です（$HOST_ENV_FILE）"
  install_runner "$host" || {
    printf '%s\n' "$(local_waiting_json "$job_id" "$repo" "" "" "${SSH_ERR:-unreachable}" "$(ssh_reason_message "${SSH_ERR:-unreachable}")")"
    return 2
  }
  local json
  if [ "$wait" = 1 ]; then
    local sha="" kind=""
    if [ -f "$STATE_DIR/results/$job_id.json" ]; then
      sha="$(jq -r '.requestedSha // ""' "$STATE_DIR/results/$job_id.json")"
    fi
    json="$(runner "$host" status "$job_id" | tail -n 1)"
    [ -n "$repo" ] || repo="$(jq -r '.repository // ""' <<<"$json")"
    [ -n "$sha" ] || sha="$(jq -r '.requestedSha // ""' <<<"$json")"
    kind="$(jq -r '.kind // ""' <<<"$json")"
    json="$(wait_for_job "$host" "$job_id" "$repo" "$sha" "$kind" "$wait_timeout")"
  else
    POST_STATUS=0
    json="$(runner "$host" status "$job_id" | tail -n 1)"
    [ -n "$repo" ] || repo="$(jq -r '.repository // ""' <<<"$json")"
  fi
  local required=false branch=""
  if load_repo_config "$repo" && [ "$C_required" = true ]; then required=true; fi
  branch="$(awk -F'\t' -v j="$job_id" '$4 == j { b = $2 } END { print b }' "$STATE_DIR/history.tsv" 2>/dev/null || true)"
  finalize "$json" "$repo" "$branch" "$required" "$host"
}

cmd_cancel() {
  local job_id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --job) job_id="${2:?}"; shift 2 ;;
      *) die_usage "unknown option: $1" ;;
    esac
  done
  [ -n "$job_id" ] || die_usage "--job を指定してください"
  local host
  host="$(resolve_host)" || die_usage "接続先が未設定です（$HOST_ENV_FILE）"
  install_runner "$host" || die_usage "$(ssh_reason_message "${SSH_ERR:-unreachable}")"
  runner "$host" cancel "$job_id"
}

cmd_log() {
  local job_id="" lines=80
  while [ $# -gt 0 ]; do
    case "$1" in
      --job) job_id="${2:?}"; shift 2 ;;
      --lines) lines="${2:?}"; shift 2 ;;
      *) die_usage "unknown option: $1" ;;
    esac
  done
  [ -n "$job_id" ] || die_usage "--job を指定してください"
  local host
  host="$(resolve_host)" || die_usage "接続先が未設定です（$HOST_ENV_FILE）"
  install_runner "$host" || die_usage "$(ssh_reason_message "${SSH_ERR:-unreachable}")"
  runner "$host" log "$job_id" "$lines"
}

cmd_config() {
  local repo=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="${2:?}"; shift 2 ;;
      *) die_usage "unknown option: $1" ;;
    esac
  done
  if [ -z "$repo" ]; then
    repo="$(repo_from_remote "$PWD")" || die_usage "--repo を指定してください"
  fi
  if ! load_repo_config "$repo"; then
    jq -cn --arg repo "$repo" '{repository: $repo, configured: false}'
    return 2
  fi
  local problems
  problems="$(config_problems)"
  jq -cn --arg repo "$repo" --arg project "$C_project" --arg workspace "$C_workspace" --arg scheme "$C_scheme" \
    --arg simulator "$C_simulator" --arg simulatorOs "$C_simulator_os" --arg tests "$C_tests" \
    --arg testPlan "$C_test_plan" --arg kind "$C_kind" --arg required "$C_required" --arg problems "$problems" '
    def nz: if . == "" then null else . end;
    {repository: $repo, configured: ($problems == ""), project: ($project | nz), workspace: ($workspace | nz),
     scheme: $scheme, simulator: $simulator, simulatorOs: ($simulatorOs | nz), tests: $tests,
     testPlan: ($testPlan | nz), kind: $kind, required: ($required == "true"),
     problems: ($problems | split("\n") | map(select(. != "")))}'
  [ -z "$problems" ]
}

cmd_doctor() {
  local host
  host="$(resolve_host)" || die_usage "接続先が未設定です（$HOST_ENV_FILE に IOS_PRECHECK_HOST=<ssh先> を書きます）"
  if ! install_runner "$host"; then
    log "$(ssh_reason_message "${SSH_ERR:-unreachable}")"
    return 2
  fi
  runner "$host" doctor
}

main() {
  local cmd="${1-}"
  shift || true
  case "$cmd" in
    run) cmd_run "$@" ;;
    status) cmd_status "$@" ;;
    cancel) cmd_cancel "$@" ;;
    log) cmd_log "$@" ;;
    config) cmd_config "$@" ;;
    doctor) cmd_doctor ;;
    *) die_usage "usage: $0 {run|status|cancel|log|config|doctor} [options]（詳細はファイル冒頭）" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
