#!/usr/bin/env bash
# リリースの統合検証・全体レビュー（`run-release-verify.sh`・`run-release-review.sh`）の工程報告（#4277）。
#
# 生存報告（heartbeat）は別プロセスで回るため、親で変数を書き換えても届かない。現在の工程と文面は
# ファイル（`RELEASE_PROGRESS_FILE`）へ書き、`running`報告のたびにそこから読む。
# 工程名は`src/lib/release-verification-progress.ts`の`RELEASE_PROGRESS_STEP_LABEL`のキーだけを使う
# （知らない名前は受け口が捨てる）。出力やログは載せない。

RELEASE_PROGRESS_FILE=""
RELEASE_PROGRESS_PLAN="[]"

# release_progress_init <計画のJSON配列>。heartbeatを起こす前に呼ぶ
release_progress_init() {
  RELEASE_PROGRESS_PLAN="$1"
  RELEASE_PROGRESS_FILE="$(mktemp "${TMPDIR:-/tmp}/issue-deck-release-progress.XXXXXX")"
}

release_progress_cleanup() {
  [[ -n "$RELEASE_PROGRESS_FILE" ]] && rm -f "$RELEASE_PROGRESS_FILE"
  return 0
}

# release_progress_set <工程> <計画内の位置> <文面> [検証コマンド] [差分のファイル数]
release_progress_set() {
  local step="$1" index="$2" message="$3" command="${4:-}" files="${5:-}"
  [[ -n "$RELEASE_PROGRESS_FILE" ]] || return 0
  jq -nc --arg step "$step" --argjson index "$index" --argjson plan "$RELEASE_PROGRESS_PLAN" \
    --arg message "$message" --arg command "$command" --arg files "$files" \
    '{message: $message, progress: ({step: $step, index: $index, plan: $plan}
      + (if $command == "" then {} else {command: $command} end)
      + (if $files == "" then {} else {files: ($files | tonumber)} end))}' \
    >"$RELEASE_PROGRESS_FILE" 2>/dev/null || true
}

# 現在の文面（無ければ空）と工程のJSON（無ければnull）
release_progress_message() {
  [[ -s "$RELEASE_PROGRESS_FILE" ]] && jq -r '.message // empty' "$RELEASE_PROGRESS_FILE" 2>/dev/null || true
}
release_progress_json() {
  if [[ -s "$RELEASE_PROGRESS_FILE" ]]; then
    jq -c '.progress // null' "$RELEASE_PROGRESS_FILE" 2>/dev/null || printf 'null'
  else
    printf 'null'
  fi
}

# 統合検証の計画。検証コマンドを文字列から依存関係取得・テスト・ビルドへ振り分け、残りは「検証コマンド」
# release_progress_integration_plan <コマンドのJSON配列> <Mac検証 true|false>
release_progress_integration_plan() {
  jq -c --arg mac "$2" '["prepare", "merge"]
    + map(if test("install|\\bci\\b") then "install" elif test("test") then "test" elif test("build") then "build" else "command" end)
    + (if $mac == "true" then ["mac"] else [] end)' <<<"$1"
}
