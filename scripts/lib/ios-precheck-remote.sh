#!/usr/bin/env bash
# iOS事前検証（#4138）のMac側の実行体。
#
# **このファイルはMacにインストールしない。** サブPCの`scripts/ios-precheck.sh`が依頼のたびに
# SSHで`$ROOT/bin/`へ送り込み、そのコピーを呼ぶ。Mac側に別の版が残っていて食い違う、という
# 状態を作らないため（送るのは数KBで、毎回送っても困らない）。
#
# ## 守ること
#
# - **Macの普段の作業ツリー（`~/apps/<repo>`）に一切触れない。** ソースはサブPCが`git archive`
#   で送ったtarをジョブ専用のディレクトリへ展開し、ビルド出力（DerivedData・xcresult）も
#   そこに置く。Mac側のgitの資格情報も要らない
# - **検証したSHAはtarから読み直す。** `git archive`はtarのpaxヘッダにコミットIDを書くので、
#   `git get-tar-commit-id`で取り出したものを`verifiedSha`として記録する。依頼された文字列を
#   そのまま書き写すと、送ったものと検証したものが一致している保証にならない
# - **Mac単位で1件ずつ実行する。** `$ROOT/lock`（mkdirの原子性）を取れたジョブだけが走り、
#   他は`queued`で待つ。macOSには`flock`が無いため
# - **ジョブIDで重複実行を防ぐ。** 同じIDの依頼が来たら、展開も実行もせず今の状態を返す
# - **SSHが切れても止まらない。** 実行はnohupで切り離し、状態は`status.json`へ逐次書く。
#   依頼側は再接続して`status`で読み直す
# - **止めるのは自分のジョブのプロセスだけ。** 各ステップは`perl`で専用のプロセスグループに
#   入れ、そのグループIDへだけシグナルを送る。名前やコマンドラインで相手を選ばない
#   （他のジョブ・普段のXcodeを巻き込まない）
#
# **macOS標準のbash 3.2で動かす。** 連想配列・`${var,,}`・`mapfile`は使えず、`set -u`の下では
# 空配列の`"${a[@]}"`が未定義エラーになる（`${a[@]+"${a[@]}"}`と書く）。
#
# 状態・結果の契約（JSONのキー）は docs/multi-agent/ios-precheck.md を正とする。
# 依頼側（`scripts/ios-precheck.sh`）と揃えて変えること。
set -uo pipefail

ROOT="${IOS_PRECHECK_ROOT:-$HOME/.issue-deck/ios-precheck}"
JOBS_DIR="$ROOT/jobs"
LOCK_DIR="$ROOT/lock"
SCHEMA_VERSION=1

# キュー待ちの上限（秒）。前のジョブが固まったまま後続が永遠に待つのを避ける
QUEUE_TIMEOUT="${IOS_PRECHECK_QUEUE_TIMEOUT:-7200}"
# 終わったジョブの記録を残す日数。これより古い**完了済み**のジョブだけを消す
KEEP_DAYS="${IOS_PRECHECK_KEEP_DAYS:-14}"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# JSONの文字列リテラルへ。制御文字は空白へ寄せる（ログの断片を入れることがあるため）
json_str() {
  local s="${1-}"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="$(printf '%s' "$s" | tr '\000-\037' ' ')"
  printf '"%s"' "$s"
}

json_num_or_null() {
  if [[ "${1-}" =~ ^-?[0-9]+$ ]]; then printf '%s' "$1"; else printf 'null'; fi
}

valid_job_id() {
  [[ "${1-}" =~ ^[A-Za-z0-9._-]{1,128}$ ]]
}

job_dir() { printf '%s/%s' "$JOBS_DIR" "$1"; }

# ---------------------------------------------------------------------------
# 状態ファイル
#
# 変数（S_*）をまとめて`status.json`へ書く。**tmpへ書いてからmvする**ので、読む側が書きかけを
# 見ることは無い。値はすべてこのファイルの中で決めた語彙か数値で、自由文字列は`S_MESSAGE`だけ。
# ---------------------------------------------------------------------------
S_STATE="" S_REASON="" S_STAGE="" S_MESSAGE=""
S_BUILD_STATUS="not_run" S_BUILD_EXIT="" S_TEST_STATUS="not_run" S_TEST_EXIT=""
S_TEST_TOTAL="" S_TEST_PASSED="" S_TEST_FAILED="" S_TEST_SKIPPED=""
S_STARTED="" S_FINISHED="" S_XCODE="" S_SIMULATOR="" S_VERIFIED_SHA=""

# job.envが`J_*`を定義する（shellcheckからは見えない）
# shellcheck disable=SC2153
load_job_env() {
  local dir="$1"
  # shellcheck disable=SC1091
  source "$dir/job.env"
}

write_status() {
  local dir="$1" tmp
  tmp="$dir/.status.json.$$"
  {
    printf '{'
    printf '"schemaVersion":%s,' "$SCHEMA_VERSION"
    printf '"jobId":%s,' "$(json_str "$J_ID")"
    printf '"repository":%s,' "$(json_str "$J_REPO")"
    printf '"requestedSha":%s,' "$(json_str "$J_SHA")"
    printf '"verifiedSha":%s,' "$(json_str "$S_VERIFIED_SHA")"
    printf '"kind":%s,' "$(json_str "$J_KIND")"
    printf '"state":%s,' "$(json_str "$S_STATE")"
    printf '"waitingReason":%s,' "$(if [ -n "$S_REASON" ]; then json_str "$S_REASON"; else printf 'null'; fi)"
    printf '"failedStage":%s,' "$(if [ -n "$S_STAGE" ]; then json_str "$S_STAGE"; else printf 'null'; fi)"
    printf '"message":%s,' "$(json_str "$S_MESSAGE")"
    printf '"build":{"status":%s,"exitCode":%s},' "$(json_str "$S_BUILD_STATUS")" "$(json_num_or_null "$S_BUILD_EXIT")"
    printf '"test":{"status":%s,"exitCode":%s,"total":%s,"passed":%s,"failed":%s,"skipped":%s},' \
      "$(json_str "$S_TEST_STATUS")" "$(json_num_or_null "$S_TEST_EXIT")" \
      "$(json_num_or_null "$S_TEST_TOTAL")" "$(json_num_or_null "$S_TEST_PASSED")" \
      "$(json_num_or_null "$S_TEST_FAILED")" "$(json_num_or_null "$S_TEST_SKIPPED")"
    printf '"environment":{"xcode":%s,"simulator":%s},' "$(json_str "$S_XCODE")" "$(json_str "$S_SIMULATOR")"
    printf '"submittedAt":%s,' "$(json_str "$J_SUBMITTED")"
    printf '"startedAt":%s,' "$(if [ -n "$S_STARTED" ]; then json_str "$S_STARTED"; else printf 'null'; fi)"
    printf '"finishedAt":%s,' "$(if [ -n "$S_FINISHED" ]; then json_str "$S_FINISHED"; else printf 'null'; fi)"
    printf '"artifacts":{"dir":%s,"buildLog":%s,"testLog":%s,"buildResult":%s,"testResult":%s}' \
      "$(json_str "$dir")" "$(json_str "$dir/build.log")" "$(json_str "$dir/test.log")" \
      "$(json_str "$dir/build.xcresult")" "$(json_str "$dir/test.xcresult")"
    printf '}\n'
  } >"$tmp" && mv -f "$tmp" "$dir/status.json"
}

is_terminal_state() {
  case "$1" in succeeded | failed | waiting) return 0 ;; *) return 1 ;; esac
}

# status.jsonから`state`だけを読む（python3を起こさない）
read_state() {
  local file="$1/status.json"
  [ -f "$file" ] || return 1
  sed -n 's/.*"state":"\([a-z_]*\)".*/\1/p' "$file" | head -n 1
}

# ---------------------------------------------------------------------------
# ロック（Mac単位で1件ずつ）
# ---------------------------------------------------------------------------
lock_owner_alive() {
  local pid
  pid="$(sed -n 's/^pid=//p' "$LOCK_DIR/owner" 2>/dev/null | head -n 1)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

acquire_lock() {
  local dir="$1" waited=0
  while :; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf 'pid=%s\njob=%s\n' "$$" "$J_ID" >"$LOCK_DIR/owner"
      return 0
    fi
    # 持ち主が死んでいる（Macの再起動・強制終了）ロックだけを外す。持ち主の生死はPIDで見る
    if [ -d "$LOCK_DIR" ] && ! lock_owner_alive; then
      sleep 1
      if ! lock_owner_alive; then
        rm -rf "$LOCK_DIR"
        continue
      fi
    fi
    if [ -f "$dir/cancel" ]; then return 2; fi
    if [ "$waited" -ge "$QUEUE_TIMEOUT" ]; then return 1; fi
    sleep 5
    waited=$((waited + 5))
  done
}

release_lock() {
  local job
  job="$(sed -n 's/^job=//p' "$LOCK_DIR/owner" 2>/dev/null | head -n 1)"
  [ "$job" = "$J_ID" ] && rm -rf "$LOCK_DIR"
}

# ---------------------------------------------------------------------------
# タイムアウト付きで1ステップを実行する
#
# 戻り値: コマンドの終了コード。タイムアウトなら124、中止なら130。
# ---------------------------------------------------------------------------
run_step() {
  local dir="$1" timeout="$2" log="$3"
  shift 3
  # 専用のプロセスグループで起こす（pgid = 自分のpid）。止めるときはこのグループへだけ送る
  perl -e 'setpgrp(0, 0); exec @ARGV or die "exec failed: $!\n"' "$@" >>"$log" 2>&1 &
  local pid=$! elapsed=0 rc
  printf '%s\n' "$pid" >"$dir/step.pid"
  while kill -0 "$pid" 2>/dev/null; do
    if [ -f "$dir/cancel" ]; then
      kill -TERM -- "-$pid" 2>/dev/null
      sleep 5
      kill -KILL -- "-$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      rm -f "$dir/step.pid"
      return 130
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      printf '\n[ios-precheck] %s秒でタイムアウトしたため停止しました\n' "$timeout" >>"$log"
      kill -TERM -- "-$pid" 2>/dev/null
      sleep 5
      kill -KILL -- "-$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      rm -f "$dir/step.pid"
      return 124
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  wait "$pid"
  rc=$?
  rm -f "$dir/step.pid"
  return "$rc"
}

# xcodebuildの失敗のうち、ソースではなく環境が原因のもの。**ここに当たったものは
# 「検証失敗」にせず検証待ちにする**——実装担当がソースを直しに行っても直らないため
ENVIRONMENT_ERROR_PATTERNS=(
  "Unable to find a destination matching"
  "Unable to boot the Simulator"
  "Failed to load the simulator"
  "CoreSimulatorService connection became invalid"
  "is not installed. To use with Xcode, first download and install the platform"
  "requires a newer version of Xcode"
  "No space left on device"
  "does not contain a scheme named"
  "xcodebuild: error: The project named"
  "xcodebuild: error: 'xcodebuild' requires"
)

classify_environment_error() {
  local log="$1" pattern
  for pattern in "${ENVIRONMENT_ERROR_PATTERNS[@]}"; do
    if grep -qF -- "$pattern" "$log" 2>/dev/null; then
      printf '%s' "$pattern"
      return 0
    fi
  done
  return 1
}

# xcresultからテスト件数を読む。読めなければ非0
read_test_counts() {
  local bundle="$1" json
  [ -d "$bundle" ] || return 1
  json="$(xcrun xcresulttool get test-results summary --path "$bundle" --compact 2>/dev/null)" || return 1
  printf '%s' "$json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
def n(k):
    v = d.get(k)
    return str(int(v)) if isinstance(v, (int, float)) else ""
print(n("totalTestCount"), n("passedTests"), n("failedTests"), n("skippedTests"))
' 2>/dev/null
}

finish() {
  local dir="$1"
  S_FINISHED="$(now_iso)"
  write_status "$dir"
  # 自分のジョブの大きな中間物だけを消す（ログ・xcresult・status.jsonは残す）
  rm -rf "$dir/src" "$dir/DerivedData" "$dir/src.tar" "$dir/step.pid" "$dir/worker.pid"
  release_lock
}

# ---------------------------------------------------------------------------
# worker: 切り離されて走る本体
# ---------------------------------------------------------------------------
cmd_worker() {
  local id="$1" dir env_error=""
  dir="$(job_dir "$id")"
  load_job_env "$dir"
  printf '%s\n' "$$" >"$dir/worker.pid"
  S_VERIFIED_SHA="$(cat "$dir/verified-sha" 2>/dev/null)"

  S_STATE="queued"
  write_status "$dir"
  acquire_lock "$dir"
  case $? in
    0) ;;
    2)
      S_STATE="waiting" S_REASON="cancelled" S_MESSAGE="キュー待ちの間に中止されました"
      S_FINISHED="$(now_iso)"
      write_status "$dir"
      rm -rf "$dir/src.tar"
      return 0
      ;;
    *)
      S_STATE="waiting" S_REASON="queue_timeout"
      S_MESSAGE="前のジョブが${QUEUE_TIMEOUT}秒以上終わらないため開始できませんでした"
      S_FINISHED="$(now_iso)"
      write_status "$dir"
      rm -rf "$dir/src.tar"
      return 0
      ;;
  esac
  trap 'release_lock' EXIT

  S_STARTED="$(now_iso)"
  S_STATE="preparing"
  write_status "$dir"

  # 環境の確認。足りないものは「検証待ち（environment）」にする
  if ! command -v xcodebuild >/dev/null 2>&1; then
    S_STATE="waiting" S_REASON="environment" S_STAGE="prepare" S_MESSAGE="xcodebuildが見つかりません"
    finish "$dir"
    return 0
  fi
  S_XCODE="$(xcodebuild -version 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
  local runtime
  runtime="$(xcrun simctl list runtimes 2>/dev/null | grep -E '^iOS ' | tail -n 1 | sed 's/ - com\.apple.*//')"
  # shellcheck disable=SC2153
  S_SIMULATOR="${J_SIMULATOR}${J_SIMULATOR_OS:+ (iOS $J_SIMULATOR_OS)}${runtime:+ / $runtime}"
  if ! xcrun simctl list devices available 2>/dev/null | grep -qF -- "    $J_SIMULATOR ("; then
    S_STATE="waiting" S_REASON="environment" S_STAGE="prepare"
    S_MESSAGE="Simulator「${J_SIMULATOR}」がMacにありません（xcrun simctl list devices available）"
    finish "$dir"
    return 0
  fi

  mkdir -p "$dir/src"
  if ! tar -xf "$dir/src.tar" -C "$dir/src" 2>>"$dir/build.log"; then
    S_STATE="waiting" S_REASON="transfer" S_STAGE="prepare" S_MESSAGE="送られたソースを展開できませんでした"
    finish "$dir"
    return 0
  fi
  rm -f "$dir/src.tar"

  local container_flag container_path
  if [ -n "$J_WORKSPACE" ]; then
    container_flag="-workspace" container_path="$J_WORKSPACE"
  else
    container_flag="-project" container_path="$J_PROJECT"
  fi
  if [ ! -e "$dir/src/$container_path" ]; then
    S_STATE="waiting" S_REASON="environment" S_STAGE="prepare"
    S_MESSAGE="このコミットに ${container_path} がありません（設定のproject/workspaceを確認してください）"
    finish "$dir"
    return 0
  fi

  local destination="platform=iOS Simulator,name=${J_SIMULATOR}${J_SIMULATOR_OS:+,OS=$J_SIMULATOR_OS}"
  local -a common=(
    xcodebuild "$container_flag" "$dir/src/$container_path" -scheme "$J_SCHEME"
    -destination "$destination" -derivedDataPath "$dir/DerivedData"
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=
  )
  local -a test_plan_args=()
  [ -n "$J_TEST_PLAN" ] && test_plan_args=(-testPlan "$J_TEST_PLAN")
  local run_tests=0
  if [ "$J_KIND" = "test" ] && [ "$J_TESTS" != "none" ]; then run_tests=1; fi

  # ビルド
  S_STATE="building"
  write_status "$dir"
  local build_action=build
  [ "$run_tests" = 1 ] && build_action=build-for-testing
  run_step "$dir" "$J_BUILD_TIMEOUT" "$dir/build.log" \
    "${common[@]}" ${test_plan_args[@]+"${test_plan_args[@]}"} -resultBundlePath "$dir/build.xcresult" "$build_action"
  local rc=$?
  S_BUILD_EXIT="$rc"
  if [ "$rc" = 130 ]; then
    S_STATE="waiting" S_REASON="cancelled" S_STAGE="build" S_BUILD_STATUS="not_run" S_MESSAGE="中止されました"
    finish "$dir"
    return 0
  fi
  if [ "$rc" = 124 ]; then
    S_STATE="waiting" S_REASON="timeout" S_STAGE="build" S_BUILD_STATUS="timeout"
    S_MESSAGE="ビルドが${J_BUILD_TIMEOUT}秒で終わりませんでした"
    finish "$dir"
    return 0
  fi
  if [ "$rc" != 0 ]; then
    if env_error="$(classify_environment_error "$dir/build.log")"; then
      S_STATE="waiting" S_REASON="environment" S_STAGE="build" S_BUILD_STATUS="not_run"
      S_MESSAGE="Macの環境が原因でビルドできません: ${env_error}"
    else
      S_STATE="failed" S_STAGE="build" S_BUILD_STATUS="failed"
      S_MESSAGE="ビルドに失敗しました（終了コード ${rc}）"
    fi
    finish "$dir"
    return 0
  fi
  S_BUILD_STATUS="passed"

  # テスト
  if [ "$J_KIND" != "test" ]; then
    S_TEST_STATUS="not_requested"
    S_STATE="succeeded" S_MESSAGE="ビルド成功（自動テストは依頼されていません）"
    finish "$dir"
    return 0
  fi
  if [ "$J_TESTS" = "none" ]; then
    S_TEST_STATUS="not_configured"
    S_STATE="succeeded" S_MESSAGE="ビルド成功（このアプリには自動テストが設定されていません）"
    finish "$dir"
    return 0
  fi

  S_STATE="testing"
  write_status "$dir"
  run_step "$dir" "$J_TEST_TIMEOUT" "$dir/test.log" \
    "${common[@]}" ${test_plan_args[@]+"${test_plan_args[@]}"} -resultBundlePath "$dir/test.xcresult" test-without-building
  rc=$?
  S_TEST_EXIT="$rc"
  local counts total="" passed="" failed="" skipped=""
  if counts="$(read_test_counts "$dir/test.xcresult")"; then
    read -r total passed failed skipped <<<"$counts"
  fi
  S_TEST_TOTAL="$total" S_TEST_PASSED="$passed" S_TEST_FAILED="$failed" S_TEST_SKIPPED="$skipped"

  if [ "$rc" = 130 ]; then
    S_STATE="waiting" S_REASON="cancelled" S_STAGE="test" S_TEST_STATUS="not_run" S_MESSAGE="中止されました"
  elif [ "$rc" = 124 ]; then
    S_STATE="waiting" S_REASON="timeout" S_STAGE="test" S_TEST_STATUS="timeout"
    S_MESSAGE="テストが${J_TEST_TIMEOUT}秒で終わりませんでした"
  elif [ "$rc" != 0 ] && env_error="$(classify_environment_error "$dir/test.log")"; then
    S_STATE="waiting" S_REASON="environment" S_STAGE="test" S_TEST_STATUS="not_run"
    S_MESSAGE="Macの環境が原因でテストを実行できません: ${env_error}"
  elif [ "$rc" != 0 ]; then
    S_STATE="failed" S_STAGE="test" S_TEST_STATUS="failed"
    S_MESSAGE="テストに失敗しました（${failed:-?}件失敗 / ${total:-?}件中）"
  elif [ -z "$total" ]; then
    # 成功で終わっても件数が読めないものは成功にしない（何が走ったか示せないため）
    S_STATE="waiting" S_REASON="environment" S_STAGE="test" S_TEST_STATUS="unknown"
    S_MESSAGE="テストは終了コード0でしたが、xcresultから件数を読めませんでした"
  elif [ "$total" = 0 ]; then
    S_STATE="failed" S_STAGE="test" S_TEST_STATUS="zero_tests"
    S_MESSAGE="テストが0件でした（テストTargetがschemeに入っているか確認してください）"
  else
    S_STATE="succeeded" S_TEST_STATUS="passed"
    S_MESSAGE="ビルド成功・テスト${passed}件成功（${total}件中、スキップ${skipped:-0}件）"
  fi
  finish "$dir"
  return 0
}

# ---------------------------------------------------------------------------
# submit: tarを標準入力から受け取り、ジョブを作って切り離す
#
# 引数は`key=value`で受ける（順序に依存させない）。
# ---------------------------------------------------------------------------
cmd_submit() {
  local id="" repo="" sha="" kind="" project="" workspace="" scheme="" simulator="" simulator_os=""
  local tests="" test_plan="" build_timeout=1800 test_timeout=1800 arg
  for arg in "$@"; do
    case "$arg" in
      id=*) id="${arg#id=}" ;;
      repo=*) repo="${arg#repo=}" ;;
      sha=*) sha="${arg#sha=}" ;;
      kind=*) kind="${arg#kind=}" ;;
      project=*) project="${arg#project=}" ;;
      workspace=*) workspace="${arg#workspace=}" ;;
      scheme=*) scheme="${arg#scheme=}" ;;
      simulator=*) simulator="${arg#simulator=}" ;;
      simulator_os=*) simulator_os="${arg#simulator_os=}" ;;
      tests=*) tests="${arg#tests=}" ;;
      test_plan=*) test_plan="${arg#test_plan=}" ;;
      build_timeout=*) build_timeout="${arg#build_timeout=}" ;;
      test_timeout=*) test_timeout="${arg#test_timeout=}" ;;
      *) printf 'unknown argument: %s\n' "$arg" >&2; return 64 ;;
    esac
  done
  if ! valid_job_id "$id" || [ -z "$repo" ] || ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || [ -z "$scheme" ] ||
    [ -z "$simulator" ] || { [ -z "$project" ] && [ -z "$workspace" ]; }; then
    printf 'invalid submit arguments\n' >&2
    return 64
  fi

  mkdir -p "$JOBS_DIR"
  local dir
  dir="$(job_dir "$id")"
  # 同じジョブIDの2回目以降は、何もせず今の状態を返す（再送・同時依頼で二重に走らせない）。
  # mkdirが原子的なので、同時に2本来ても片方しか作れない
  if ! mkdir "$dir" 2>/dev/null; then
    cat >/dev/null # 送られてきたtarは読み捨てる
    if [ -f "$dir/status.json" ]; then
      printf 'DUPLICATE\n'
      cat "$dir/status.json"
    else
      printf 'DUPLICATE\n{"jobId":%s,"state":"queued"}\n' "$(json_str "$id")"
    fi
    return 0
  fi

  cat >"$dir/src.tar"
  local verified
  verified="$(git get-tar-commit-id <"$dir/src.tar" 2>/dev/null)"
  printf '%s\n' "$verified" >"$dir/verified-sha"

  {
    printf 'J_ID=%q\n' "$id"
    printf 'J_REPO=%q\n' "$repo"
    printf 'J_SHA=%q\n' "$sha"
    printf 'J_KIND=%q\n' "$kind"
    printf 'J_PROJECT=%q\n' "$project"
    printf 'J_WORKSPACE=%q\n' "$workspace"
    printf 'J_SCHEME=%q\n' "$scheme"
    printf 'J_SIMULATOR=%q\n' "$simulator"
    printf 'J_SIMULATOR_OS=%q\n' "$simulator_os"
    printf 'J_TESTS=%q\n' "$tests"
    printf 'J_TEST_PLAN=%q\n' "$test_plan"
    printf 'J_BUILD_TIMEOUT=%q\n' "$build_timeout"
    printf 'J_TEST_TIMEOUT=%q\n' "$test_timeout"
    printf 'J_SUBMITTED=%q\n' "$(now_iso)"
  } >"$dir/job.env"
  load_job_env "$dir"
  S_VERIFIED_SHA="$verified"

  if [ "$verified" != "$sha" ]; then
    S_STATE="waiting" S_REASON="transfer" S_STAGE="prepare"
    S_MESSAGE="受け取ったソースのコミット（${verified:-不明}）が依頼したSHAと一致しません"
    S_FINISHED="$(now_iso)"
    write_status "$dir"
    rm -f "$dir/src.tar"
    printf 'SUBMITTED\n'
    cat "$dir/status.json"
    return 0
  fi

  S_STATE="queued"
  write_status "$dir"
  # SSHが切れても走り続けるよう切り離す
  nohup bash "${BASH_SOURCE[0]}" worker "$id" </dev/null >>"$dir/worker.log" 2>&1 &
  printf 'SUBMITTED\n'
  cat "$dir/status.json"
  prune_old_jobs
}

cmd_status() {
  local id="$1" dir
  valid_job_id "$id" || { printf 'invalid job id\n' >&2; return 64; }
  dir="$(job_dir "$id")"
  if [ ! -f "$dir/status.json" ]; then
    printf '{"jobId":%s,"state":"unknown"}\n' "$(json_str "$id")"
    return 0
  fi
  # 実行中のはずなのにworkerが居ない（Macの再起動など）なら、そのことを返す
  local state pid
  state="$(read_state "$dir")"
  if ! is_terminal_state "$state"; then
    pid="$(cat "$dir/worker.pid" 2>/dev/null)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null; then
      load_job_env "$dir"
      S_VERIFIED_SHA="$(cat "$dir/verified-sha" 2>/dev/null)"
      S_STATE="waiting" S_REASON="interrupted" S_MESSAGE="Mac側の実行が途中で終了しました（Macの再起動など）"
      S_FINISHED="$(now_iso)"
      write_status "$dir"
    fi
  fi
  cat "$dir/status.json"
}

cmd_cancel() {
  local id="$1" dir pid
  valid_job_id "$id" || { printf 'invalid job id\n' >&2; return 64; }
  dir="$(job_dir "$id")"
  [ -d "$dir" ] || { printf 'no such job\n' >&2; return 1; }
  touch "$dir/cancel"
  # workerが拾って自分のステップだけを止める。ステップが居ない間（キュー待ち）は次の巡回で抜ける
  pid="$(cat "$dir/step.pid" 2>/dev/null)"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  fi
  printf 'CANCEL_REQUESTED\n'
}

cmd_log() {
  local id="$1" lines="${2:-80}" dir
  valid_job_id "$id" || { printf 'invalid job id\n' >&2; return 64; }
  [[ "$lines" =~ ^[0-9]+$ ]] || lines=80
  dir="$(job_dir "$id")"
  local f
  for f in build.log test.log; do
    [ -f "$dir/$f" ] || continue
    printf '===== %s（末尾%s行） =====\n' "$f" "$lines"
    # エラー行を先に拾う（末尾だけだとxcodebuildの要約行しか見えないことが多い）
    grep -nE '(error|failed|FAILED|fatal):' "$dir/$f" | tail -n 30
    printf -- '----- tail -----\n'
    tail -n "$lines" "$dir/$f"
  done
}

# 環境の確認だけを行う（導入時・接続確認用）。値はMac側の構成情報なので、そのまま公開の場へ貼らない
cmd_doctor() {
  printf 'xcodebuild: %s\n' "$(command -v xcodebuild || printf 'missing')"
  xcodebuild -version 2>/dev/null | tr '\n' ' '
  printf '\npython3: %s\n' "$(command -v python3 || printf 'missing')"
  printf 'perl: %s\n' "$(command -v perl || printf 'missing')"
  printf 'git: %s\n' "$(command -v git || printf 'missing')"
  printf 'runtimes:\n'
  xcrun simctl list runtimes 2>/dev/null | grep -E '^iOS ' | sed 's/^/  /'
  printf 'lock: %s\n' "$(if [ -d "$LOCK_DIR" ]; then sed -n 's/^job=//p' "$LOCK_DIR/owner" 2>/dev/null; else printf 'free'; fi)"
}

# 終わったジョブのうち古いものだけを消す。実行中・キュー待ちのジョブには触れない
prune_old_jobs() {
  local d state
  [ -d "$JOBS_DIR" ] || return 0
  while IFS= read -r d; do
    state="$(read_state "$d")"
    is_terminal_state "$state" || continue
    rm -rf "$d"
  done < <(find "$JOBS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" 2>/dev/null)
}

main() {
  local cmd="${1-}"
  shift || true
  case "$cmd" in
    submit) cmd_submit "$@" ;;
    worker) cmd_worker "$@" ;;
    status) cmd_status "$@" ;;
    cancel) cmd_cancel "$@" ;;
    log) cmd_log "$@" ;;
    doctor) cmd_doctor ;;
    *)
      printf 'usage: %s {submit|status|cancel|log|doctor} ...\n' "$0" >&2
      return 64
      ;;
  esac
}

main "$@"
