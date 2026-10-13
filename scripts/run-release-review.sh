#!/usr/bin/env bash
# リリースPR（base=main・head=release-main/v*）の差分全体のAIレビュー（#4238・#4212）。
#
# 呼ぶのはサブPCのpoller。DispatchJob（`RELEASE_REVIEW`）を取ったpollerが、tmuxの中で起動する。
# `base...head`の差分全体を読み取り専用のAI（担当はサーバー設定で決まり、`claude`か`codex`）へ渡し、
# 指摘・影響PR・影響ファイルを`/api/dispatch/report`の`releaseReview`として報告する。
#
#   scripts/run-release-review.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <agent> <claudeモデル> <codexモデル>
#
# **差分が大きいときはバッチに分けて順に確認し、最後にバッチをまたぐ相互作用を確認する**（#4615）。
# 入力へ載せた数（`inputFiles`）と、根拠つきで確認した実績（`fileReviews`）は別に報告する。
# サーバーは実績から確認済みの件数を数え、足りなければ「未確認範囲あり」として準備完了にしない。
# 中断・実行予算で残ったバッチは`*.batches`へ保存し、同じbase・headの再実行が続きから確認する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/review-usage.sh
source "$SCRIPT_DIR/lib/review-usage.sh"
# shellcheck source=scripts/lib/release-progress.sh
source "$SCRIPT_DIR/lib/release-progress.sh"
# shellcheck source=scripts/lib/agent-cli.sh
source "$SCRIPT_DIR/lib/agent-cli.sh"

WORK_ROOT="${ISSUE_DECK_RELEASE_REVIEW_ROOT:-${TMPDIR:-/tmp}/issue-deck-release-review}"
TIMEOUT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_TIMEOUT_SECONDS:-1800}"
HEARTBEAT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_HEARTBEAT_SECONDS:-60}"
# 1バッチのプロンプトへ入れる差分の上限（文字数）。超えた分は次のバッチへ送る。1ファイルが超えるときは分割する
# 1回の起動で実行するバッチ数の上限（実行予算）。残りは保存して、再実行が続きから確認する（#4615）
DIFF_BUDGET_BYTES="${ISSUE_DECK_RELEASE_REVIEW_DIFF_BUDGET_BYTES:-300000}"
MAX_BATCHES_PER_RUN="${ISSUE_DECK_RELEASE_REVIEW_MAX_BATCHES_PER_RUN:-8}"

JOB_ID=""
JOB_REPORTED=0
RUNNING_MESSAGE="全体レビューを準備しています"
HEARTBEAT_PID=""
WORKTREE=""
LOCAL_PATH=""
ERR_FILE=""
part_dir=""

# 実行失敗の診断（#4300）。**コードへの指摘ではなく「レビューを最後まで行えなかった理由」**で、
# 画面に出す。原因は観測できた事実だけで決め、決められなければ unknown（原因未特定）にする。
# 抜粋は末尾だけ・機密を伏せる（サーバー側でも同じ除去を通す。ここは外へ出す前の一次防御）。
diag_redact() {
  sed -E \
    -e 's/(Bearer|Basic)[[:space:]]+[A-Za-z0-9._~+\/=-]{8,}/\1 [除去]/Ig' \
    -e 's#op://[^[:space:]]+#op://[除去]#g' \
    -e 's#(https?://)[^[:space:]/@:]+(:[^[:space:]/@]*)?@#\1[除去]@#Ig' \
    -e 's/(gh[pousr]_|github_pat_|sk-ant-|sk-|xox[abprs]-|AKIA|AIza|eyJ)[A-Za-z0-9_.-]{8,}/[トークンを除去]/g' \
    -e 's/([A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION|CREDENTIAL)[A-Za-z0-9_]*)[[:space:]]*[=:][[:space:]]*[^[:space:]]+/\1=[除去]/Ig'
}

# diag_excerpt <ファイル>: 末尾30行・2000文字までを機密除去して返す（無ければ空）
diag_excerpt() {
  local file="${1:-}"
  [[ -n "$file" && -s "$file" ]] || return 0
  tail -n 30 "$file" 2>/dev/null | tr -d '\000' | diag_redact | tail -c 2000 || true
}

# diag_stage: 最後に確認できた工程（進捗ファイルの現在の工程）。無ければ空
diag_stage() {
  [[ -n "${RELEASE_PROGRESS_FILE:-}" && -s "$RELEASE_PROGRESS_FILE" ]] || return 0
  jq -r '.progress.step // empty' "$RELEASE_PROGRESS_FILE" 2>/dev/null || true
}

# diag_payload <原因> [終了コード] [抜粋ファイル] [工程]: releaseReviewとして報告するJSON
diag_payload() {
  local cause="$1" code="${2:-}" excerpt_file="${3:-}" stage="${4:-}"
  [[ -n "$stage" ]] || stage="$(diag_stage)"
  jq -nc --arg cause "$cause" --arg code "$code" --arg stage "$stage" --arg excerpt "$(diag_excerpt "$excerpt_file")" \
    '{diagnostic: ({cause: $cause}
      + (if $stage == "" then {} else {stage: $stage} end)
      + (if $code == "" then {} else {exitCode: ($code | tonumber)} end)
      + (if $excerpt == "" then {} else {excerpt: $excerpt} end))}' 2>/dev/null || true
}

# diag_ai_cause <終了コード> <ログ>: AI CLIが非0で終わったときの原因。事実が無ければ unknown
diag_ai_cause() {
  local code="$1" log="$2"
  case "$code" in
    124 | 137) printf 'timeout'; return ;;
    126 | 127) printf 'launch_failed'; return ;;
  esac
  if [[ -s "$log" ]] && tail -n 60 "$log" | grep -qiE 'not logged in|please (log ?in|run .*login)|unauthorized|authentication (failed|error)|invalid (api key|token)|\b401\b|expired (token|session)'; then
    printf 'auth_failed'
    return
  fi
  printf 'unknown'
}

# review_report <running|succeeded|failed> <メッセージ> [releaseReview JSON]
review_report() {
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
      + (if $result == "" then {} else {releaseReview: ($result | fromjson)} end)')" || return 0
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
      review_report running "$RUNNING_MESSAGE"
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

# どの経路で終わっても終了を1回だけ報告する
finish() {
  local status="$1" message="$2" result="${3:-}"
  [[ "$JOB_REPORTED" -eq 0 ]] || return 0
  JOB_REPORTED=1
  heartbeat_stop
  review_report "$status" "$message" "$result"
}

cleanup() {
  local code=$?
  if ((code != 0)); then
    # 想定外の失敗。原因は特定できないので unknown とし、最後の工程とstderr末尾だけを残す
    finish failed "全体レビューの実行中に失敗しました（終了コード ${code}）。" \
      "$(diag_payload unknown "$code" "$ERR_FILE")"
  fi
  [[ -n "$ERR_FILE" ]] && rm -f "$ERR_FILE"
  [[ -n "${part_dir:-}" ]] && rm -rf "$part_dir"
  if [[ -n "$WORKTREE" && -n "$LOCAL_PATH" ]]; then
    git -C "$LOCAL_PATH" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
  fi
  release_progress_cleanup
}

# AIの最終応答から最後のjsonコードブロック（無ければ全体）を取り出す。JSONでなければ非0
extract_result_json() {
  local file="$1" block
  block="$(awk '/^```json/{buf="";inblk=1;next} /^```/{if(inblk){last=buf;inblk=0};next} inblk{buf=buf $0 "\n"} END{printf "%s", last}' "$file")"
  [[ -n "$block" ]] || block="$(cat "$file")"
  jq -ce 'select(type == "object")' <<<"$block" 2>/dev/null
}

# 再レビューの文脈（前回の対象・結果・指摘・修正の対応内容）をサーバーから取る（#4559）。
# 取れなければ空を返す（旧サーバー・未設定でも従来どおり全体確認として動く）
fetch_review_context() {
  local app_base_url dispatch_secret
  [[ -n "$JOB_ID" ]] || return 1
  app_base_url="$(_review_usage_env_value APP_BASE_URL)"
  dispatch_secret="$(_review_usage_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 1
  printf 'Authorization: Bearer %s\n' "$dispatch_secret" |
    curl --silent --fail --max-time 20 --header @- --get --data-urlencode "jobId=$JOB_ID" \
      "${app_base_url%/}/api/dispatch/release-review-context" 2>/dev/null |
    jq -ce 'select(type == "object")' 2>/dev/null
}

# review_context_text <context JSON> <実効モード initial|rereview> <引き継げない理由> <修正差分のファイル一覧ファイル> <修正差分ファイル>
# 再レビュー（または前回記録つきの全体確認）の節を標準出力へ。前回の記録が無ければ何も出さない
review_context_text() {
  local ctx="$1" mode="$2" reason="$3" files_file="$4" diff_file="$5"
  jq -e '.previous != null' <<<"$ctx" >/dev/null 2>&1 || return 0
  if [[ "$mode" == "rereview" ]]; then
    printf '## 再レビュー（前回の結果の引き継ぎ）\n\nこれは再レビューです。前回の対象（PR #%s・head %s）で確認した結果と、そこから今回の対象までの修正差分を渡します。**変更の無い領域は有効な前回の記録を参照してよいですが、毎回無条件に引き継ぐのではなく、影響のある範囲は今回確認し直してください。**\n\n' \
      "$(jq -r '.previous.prNumber' <<<"$ctx")" "$(jq -r '.previous.headSha[0:12]' <<<"$ctx")"
  else
    printf '## 前回の記録（参考・今回は対象全体を確認する）\n\n前回の記録は残っていますが、**%s**。前回の確認結果は引き継がず、対象全体を確認してください。前回の指摘が今回も残っているかは確認し、同じ指摘であれば`previousId`を付けて報告します。\n\n' "${reason:-引き継げる条件ではありません}"
  fi
  printf '### 前回の止める指摘\n\n'
  jq -r '(.previousFindings // []) | if length == 0 then "（なし）" else .[] | "- `\(.id)` \(.file // "-")\(if .line then ":\(.line)" else "" end) \(.title) — \(.detail[0:300])\(if $fix[.id] then "（修正Issue #\($fix[.id])）" else "" end)" end' \
    --argjson fix "$(jq -c '.fixIssueByFinding // {}' <<<"$ctx")" <<<"$ctx"
  printf '\n### 修正の対応内容と検証根拠（修正系列の記録）\n\n'
  jq -r '(.fixHistory // []) | if length == 0 then "（記録なし）" else .[] | "- 修正Issue #\(.issueNumber)（修正PR \(if .fixPrNumber then "#\(.fixPrNumber)" else "なし" end)・状態 \(.status)）", (.findings[]? | "  - `\(.key)` \(.title)［\(.status)・再発\(.reopenCount)回］根拠: \((.resolution // "なし")[0:300])") end' <<<"$ctx"
  printf '\n### 前回の確認項目の結果\n\n'
  jq -r '.previous.statuses | to_entries | if length == 0 then "（なし）" else .[] | "- `\(.key)`: \(.value)" end' <<<"$ctx"
  if [[ -s "$files_file" ]]; then
    printf '\n### 前回の対象から今回までの修正差分\n\n変更ファイル:\n'
    head -n 200 "$files_file" | sed 's/^/- /'
    printf '\n```diff\n'
    cat "$diff_file"
    printf '\n```\n'
  fi
  if [[ "$mode" == "rereview" ]]; then
    cat <<'RULES'

### 再レビューの進め方

1. **前回の止める指摘ごとに**、解消したか（`resolved`・根拠必須）／未解消か（`unresolved`）を確認し、`previousFindings`へ出力する。未解消のものは`findings`にも`previousId`つきで入れる
2. 修正差分と、それが影響する呼び出し元・関連機能を再確認する。**修正で新しく生じた問題があれば新規の指摘として出す**。新規の指摘には`discovery`を付ける（修正の結果生じた＝`fix_induced`、前回も見えたはずの見落とし＝`initial_miss`、今回の対象に追加された変更＝`scope_added`、判断できない＝`unknown`）
3. 修正差分の影響を受けない確認項目は、前回の結果を引き継いでよい（`"source": "carried_over"`）。**根拠には「なぜ今回の対象にも当てはまるか」を書く**。影響を受ける項目、前回に`unconfirmed`だった項目は今回確認する（`"source": "current"`）
4. 再確認した範囲と、その範囲を選んだ理由を`recheckScope`に書く
5. **前回に無かった重大な問題でも、見つけたら必ず報告する。** 前回未指摘であることを理由に無視しない

再レビューは合格の保証ではありません。現在の対象で必須項目に未確認が無く、止める指摘が無いときだけ合格です。
RULES
  fi
}

# plan_batches: `files`の差分を、`DIFF_BUDGET_BYTES`ごとのバッチ（`$batch_dir/b<N>.diff|.files`）へ詰める。
# 1ファイルが上限を超えるときは断片に分け、断片ごとに別バッチへ置く（黙って除外しない）。
# 差分を取得できなかったファイルは`runner.json`へ取得不能として残す。`batch_count`・`input_files`を設定する
plan_batches() {
  local file file_diff size off parts k bi=1 used=0
  : >"$batch_dir/runner.entries"
  rm -f "$batch_dir"/b*.diff "$batch_dir"/b*.files
  : >"$batch_dir/b1.diff"
  : >"$batch_dir/b1.files"
  input_files=0
  for file in "${files[@]}"; do
    if ! file_diff="$(git -C "$WORKTREE" diff "$base_sha...$head_sha" -- "$file" 2>/dev/null)"; then
      jq -nc --arg f "$file" '{file: $f, status: "unreadable", evidence: "差分を取得できませんでした（git diffが失敗）"}' >>"$batch_dir/runner.entries"
      continue
    fi
    size="${#file_diff}"
    if ((size == 0)); then
      jq -nc --arg f "$file" '{file: $f, status: "reviewed", evidence: "差分が空（内容の変更なし）をランナーが確認"}' >>"$batch_dir/runner.entries"
      continue
    fi
    input_files=$((input_files + 1))
    if ((size > DIFF_BUDGET_BYTES)); then
      # 巨大ファイル: 断片ごとに専用のバッチを作る。全断片の確認が揃って初めて確認済みになる
      if [[ -s "$batch_dir/b${bi}.files" ]]; then
        bi=$((bi + 1))
        : >"$batch_dir/b${bi}.diff"
        : >"$batch_dir/b${bi}.files"
      fi
      parts=$(((size + DIFF_BUDGET_BYTES - 1) / DIFF_BUDGET_BYTES))
      for ((k = 0; k < parts; k++)); do
        off=$((k * DIFF_BUDGET_BYTES))
        printf '（%s の差分を分割して載せています: %d/%d）\n%s\n' "$file" "$((k + 1))" "$parts" "${file_diff:off:DIFF_BUDGET_BYTES}" >"$batch_dir/b${bi}.diff"
        printf '%s\t%d/%d\n' "$file" "$((k + 1))" "$parts" >"$batch_dir/b${bi}.files"
        bi=$((bi + 1))
        : >"$batch_dir/b${bi}.diff"
        : >"$batch_dir/b${bi}.files"
      done
      used=0
      continue
    fi
    if ((used + size > DIFF_BUDGET_BYTES)) && [[ -s "$batch_dir/b${bi}.files" ]]; then
      bi=$((bi + 1))
      : >"$batch_dir/b${bi}.diff"
      : >"$batch_dir/b${bi}.files"
      used=0
    fi
    printf '%s\n' "$file_diff" >>"$batch_dir/b${bi}.diff"
    printf '%s\t\n' "$file" >>"$batch_dir/b${bi}.files"
    used=$((used + size))
  done
  # 末尾の空のバッチは捨てる
  [[ -s "$batch_dir/b${bi}.files" ]] || { rm -f "$batch_dir/b${bi}.diff" "$batch_dir/b${bi}.files"; bi=$((bi - 1)); }
  batch_count="$bi"
}

# batch_coverage_text <バッチ番号>: そのバッチの対象とファイル別の実績の出し方
batch_coverage_text() {
  local idx="$1" list
  list="$(cut -f1,2 "$batch_dir/b${idx}.files" | awk -F'\t' '{printf "- %s%s\n", $1, ($2 == "" ? "" : "（分割 " $2 "）")}')"
  printf '差分%dファイルを%dバッチに分けて確認しています。**これはバッチ%d/%dです。** 次のファイルの差分をこのバッチへ載せました:\n%s\n\n' \
    "${#files[@]}" "$batch_count" "$idx" "$batch_count" "$list"
  printf 'リリース全体の変更ファイル（他のバッチの分を含む。呼び出し元・関連コードを調べるときの参考）:\n%s\n\n' \
    "$(printf -- '- %s\n' "${files[@]:0:300}")"
  cat <<'RULES'
**ファイル別の確認実績を`fileReviews`へ出力してください。** このバッチへ載せたファイルそれぞれについて、
差分を読み、必要なら周辺コードも確認したうえで、`{"file": "パス", "status": "reviewed", "evidence": "読んだ箇所・確認した内容"}`を出します。
読めなかった・確認しきれなかったファイルは`"status": "unreadable"`（または出力しない）にし、理由を`evidence`へ書きます。
**根拠（`evidence`）の無い`reviewed`、差分を載せていないファイルの`reviewed`は確認済みとして数えません。** 差分が載っていることは確認の根拠になりません。
分割されたファイル（分割 k/m）は、この断片を読んだ根拠で出力してください（全断片が揃って初めて確認済みになります）。
このバッチ以外のファイルとの関係（呼び出し元・同じAPIの利用側など）は、作業ディレクトリのコードを読んで確認します。
`checks`は、このバッチの差分について確認項目ごとに出力します（バッチをまたぐ相互作用は、全バッチの後に別に確認します）。
RULES
}

# integration_coverage_text: 全バッチ後の相互作用確認の指示（差分は載せない）
integration_coverage_text() {
  printf '差分%dファイルは%dバッチに分けて確認済みです。**これは全バッチの後の「バッチをまたぐ相互作用の確認」です。** 差分の本文は載せていません。\n\n' \
    "${#files[@]}" "$batch_count"
  printf 'リリース全体の変更ファイル:\n%s\n\n' "$(printf -- '- %s\n' "${files[@]:0:300}")"
  cat <<'RULES'
下の「バッチごとの結果」は個別のバッチだけを見た確認結果です。**単純に集計せず、バッチをまたぐ問題を確認してください。**
- 別のバッチの変更同士が相反・不整合になっていないか（片方だけ反映された変更、関数・API・スキーマ変更に対する呼び出し元の更新漏れ）
- 各バッチの指摘・未確認の項目が、他のバッチの変更で解消または悪化していないか
作業ディレクトリ（対象のhead）の該当ファイルを`Read`・`Grep`・`Glob`で実際に読み、確認した箇所を`checks`の根拠へ書きます。
`checks`は確認項目すべてについて、リリース全体の観点で出力します。`fileReviews`は空配列で構いません（ファイル別の実績はバッチごとに記録済み）。
バッチごとの指摘はこちらで集約するため、ここでは**バッチをまたぐ新しい指摘だけ**を`findings`へ出します。
RULES
}

# integration_digest_text: 相互作用の確認へ渡す、バッチごとの結果の要約（差分の代わり）
integration_digest_text() {
  local idx
  for ((idx = 1; idx <= batch_count; idx++)); do
    printf '### バッチ%d/%d\n\n' "$idx" "$batch_count"
    jq -r --arg files "$(cut -f1 "$batch_dir/b${idx}.files" | sort -u | paste -sd, -)" '
      "対象: \($files)\n所見: \((.summary // "")[0:800])\n",
      "指摘:",
      ((.findings // []) | if length == 0 then "- （なし）" else .[:20][] | "- \(.title // "-")（\(.file // "-")）: \((.detail // "")[0:200])" end),
      "確認項目:",
      ((.checks // []) | .[] | "- `\(.id)` \(.status): \((.evidence // "")[0:200])")' "$batch_dir/r${idx}.json"
    printf '\n'
  done
}

# build_prompt <出力先>: `$part_dir`の部品（coverage・diff・prs・checklist…）からプロンプトを組み立てる
build_prompt() {
  local out="$1"
  python3 - "$SCRIPT_DIR/prompts/release-review-agent.md" "$out" "$full_name" "$pr_number" "$base_sha" "$head_sha" \
    "$part_dir" <<'PY'
import sys
template, out, repo, pr, base, head, parts = sys.argv[1:8]
def part(name):
    try:
        return open(parts + "/" + name, encoding="utf-8", errors="replace").read()
    except FileNotFoundError:
        return ""
text = open(template, encoding="utf-8").read()
version = part("version").strip()
mode = part("mode").strip()
has_prev = part("hasprev").strip() == "yes"
if version:
    checklist, blocking = part("checklist"), part("blocking")
else:
    # サーバーから確認項目を取れなかったとき（旧サーバー・通信失敗）。項目別の記録は出せない
    checklist = "（確認項目を取得できませんでした。リリース全体として上の観点を確認してください）"
    blocking = ""
repl = {
    "{{REPOSITORY}}": repo, "{{PR_NUMBER}}": pr, "{{BASE_SHA}}": base, "{{HEAD_SHA}}": head,
    "{{COVERAGE}}": part("coverage"), "{{PULL_REQUESTS}}": part("prs"), "{{DIFF}}": part("diff"),
    "{{CHECKLIST_VERSION}}": version or "0",
    "{{CHECKLIST}}": checklist, "{{BLOCKING_POLICY}}": blocking, "{{REREVIEW}}": part("rereview"),
    "{{CHECK_SOURCE_HINT}}": ', "source": "current|carried_over"' if mode == "rereview" else "",
    "{{FINDING_HINT}}": ', "previousId": "前回の指摘ID（同じ指摘の再発のとき）", "discovery": "fix_induced|initial_miss|scope_added|unknown（新規のとき）", "stallCause": "unfixed|fix_ineffective|verification_insufficient|execution_failure|unknown（再発のとき）"' if has_prev else "",
    "{{REREVIEW_FIELDS}}": ',\n  "previousFindings": [ { "id": "前回の指摘ID", "status": "resolved|unresolved", "evidence": "解消または未解消の根拠" } ],\n  "recheckScope": "再確認した範囲と選んだ理由"' if has_prev else "",
}
for key, value in repl.items():
    text = text.replace(key, value)
open(out, "w", encoding="utf-8").write(text)
PY
}

# run_agent <プロンプト> <出力> <ログ>: AI CLIを読み取り専用で1回実行する。終了コードを返す
run_agent() {
  local prompt="$1" out="$2" log="$3"
  if [[ "$agent" == "codex" ]]; then
    local -a codex_args=(exec --sandbox read-only --ephemeral -m "$codex_model" --output-last-message "$out" -C "$WORKTREE")
    (cd "$WORKTREE" && timeout -k 60 "$TIMEOUT_SECONDS" "$codex_command" "${codex_args[@]}" <"$prompt" >"$log" 2>&1)
  else
    local -a claude_args=(-p --model "$claude_model" --allowedTools Read Grep Glob)
    (cd "$WORKTREE" && timeout -k 60 "$TIMEOUT_SECONDS" claude "${claude_args[@]}" <"$prompt" >"$out" 2>"$log")
  fi
}

# merge_batch_results <未実施のバッチ数>: 保存済みのバッチ結果（と相互作用の確認）を1つの結果へまとめる。
# 確認項目は、**全バッチ（と相互作用の確認）が確認済み・非該当と根拠を報告した項目だけ**を確認済みにする。
# ファイルは、含まれる全バッチ（巨大ファイルは全断片）で根拠つきの`reviewed`が揃ったものだけを確認済みとして出す
merge_batch_results() {
  local pending="$1" idx
  local -a batch_results=() all_results=()
  for ((idx = 1; idx <= batch_count; idx++)); do
    [[ -s "$batch_dir/r${idx}.json" ]] && batch_results+=("$batch_dir/r${idx}.json")
  done
  all_results=("${batch_results[@]}")
  [[ -s "$batch_dir/rint.json" ]] && all_results+=("$batch_dir/rint.json")
  local expected_results=$batch_count targets_json expected_json runner_json
  ((batch_count > 1)) && expected_results=$((batch_count + 1))
  targets_json="$(printf '%s\n' "${files[@]}" | jq -Rsc 'split("\n") | map(select(. != ""))')"
  expected_json="$(cut -f1 "$batch_dir"/b*.files 2>/dev/null | jq -Rsc 'split("\n") | map(select(. != "")) | group_by(.) | map({key: .[0], value: length}) | from_entries')"
  runner_json="$(jq -sc '.' "$batch_dir/runner.entries" 2>/dev/null || printf '[]')"
  [[ ${#all_results[@]} -gt 0 ]] || { printf '{"state":"passed","targetFiles":%s,"fileReviews":%s,"inputFiles":0,"batches":%d,"pendingBatches":%d}' "$targets_json" "$runner_json" "$batch_count" "$pending"; return 0; }

  local file_reviews
  file_reviews="$( ((${#batch_results[@]} > 0)) && jq -sc --argjson expected "$expected_json" --argjson runner "$runner_json" '
      . as $rs
      | ($expected | to_entries | map(
          .key as $f | .value as $n
          | [ $rs[] | (.fileReviews // []) | map(select(.file == $f)) ] as $per
          | [ $per[][] | select(.status == "unreadable") ] as $bad
          | [ $per[] | map(select(.status == "reviewed" and ((.evidence // "") | tostring | length) > 0)) | select(length > 0) | .[0] ] as $ok
          | if ($bad | length) > 0 then {file: $f, status: "unreadable", evidence: (($bad[0].evidence // "確認できませんでした") | tostring | .[0:300])}
            elif ($ok | length) >= $n then {file: $f, status: "reviewed", evidence: ($ok | map(.evidence | tostring) | join(" / ") | .[0:480])}
            else empty end
        )) + $runner' "${batch_results[@]}" || printf '%s' "$runner_json")"

  jq -sc --argjson expected_results "$expected_results" --argjson pending "$pending" --argjson targets "$targets_json" \
    --argjson fileReviews "$file_reviews" --argjson inputFiles "$input_files" --argjson batches "$batch_count" '
    . as $rs
    | def uniq_by_key: group_by([.title, .file, .line]) | map(.[0]);
    {
      state: (if any($rs[]; .state == "needs_check") or any($rs[]; (.findings // []) | any(.blocking != false)) then "needs_check" else "passed" end),
      summary: ([ $rs | to_entries[] | . as $e | ($e.value.summary // "") | select(. != "") | "[\(if $e.key < $batches then "バッチ\($e.key + 1)" else "相互作用の確認" end)] \(.[0:1500])" ] | join("\n") | .[0:19000]),
      checklistVersion: ([ $rs[] | .checklistVersion // empty ] | first),
      checks: (
        [ $rs[] | (.checks // [])[] ] | group_by(.id) | map(
          .[0].id as $id | . as $e
          | if ($e | length) < $expected_results then
              {id: $id, status: "unconfirmed", evidence: "未実施または報告の無いバッチがあります（\($e | length)/\($expected_results)件）"}
            elif any($e[]; (.status != "confirmed" and .status != "not_applicable") or ((.evidence // "") | tostring | length) == 0) then
              {id: $id, status: "unconfirmed", evidence: ([ $e[] | select(.status == "unconfirmed" or ((.evidence // "") | tostring | length) == 0) | (.evidence // "根拠が報告されていません") | tostring ] | join(" / ") | .[0:1400])}
            else
              {id: $id, status: (if any($e[]; .status == "confirmed") then "confirmed" else "not_applicable" end),
               evidence: ($e | map(.evidence | tostring) | join(" / ") | .[0:1400]),
               source: (if all($e[]; .source == "carried_over") then "carried_over" else "current" end)}
            end)),
      unverifiedScope: ([ $rs[] | .unverifiedScope // empty ] | join(" / ") | if . == "" then null else .[0:1900] end),
      findings: ([ $rs[] | (.findings // [])[] ] | uniq_by_key | .[0:50]),
      affectedPullRequests: ([ $rs[] | (.affectedPullRequests // [])[] ] | unique),
      affectedFiles: ([ $rs[] | (.affectedFiles // [])[] ] | unique | .[0:200]),
      previousFindings: ([ $rs[] | (.previousFindings // [])[] ] | group_by(.id) | map(
        (map(select(.status == "unresolved")) | first) // (map(select(.status == "resolved" and ((.evidence // "") | length) > 0)) | first) // .[0])),
      recheckScope: ([ $rs[] | .recheckScope // empty ] | join(" / ") | if . == "" then null else .[0:1400] end),
      targetFiles: $targets,
      fileReviews: $fileReviews,
      inputFiles: $inputFiles,
      batches: $batches,
      pendingBatches: $pending
    }
    | with_entries(select(.value != null))' "${all_results[@]}"
}

main() {
  local owner="$1" repo="$2" pr_number="$3" base_sha="$4" head_sha="$5"
  JOB_ID="$6"
  local agent="$7" claude_model="${8:-}" codex_model="${9:-}"
  local full_name="$owner/$repo" prompt_file output_file log_file ai_json
  local total_files=0 prs_text=""
  local -a files=() fix_files=() added_prs=() unrelated_prs=()
  local ctx_json="" ctx_mode="initial" effective_mode="initial" deny_reason="" prev_head="" fix_prs_json="[]"
  local checklist_version="" fix_diff_count=0
  local batch_dir="" batch_count=0 input_files=0 codex_command=""

  trap cleanup EXIT
  # 想定外の失敗でstderrの末尾を診断へ載せるため、写しを取る（端末への出力はそのまま残る）
  ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/issue-deck-release-review-err.XXXXXX")"
  exec 2> >(tee -a "$ERR_FILE" >&2)
  TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-}"
  for tool in git jq timeout; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Error: $tool コマンドが見つかりません。" >&2; exit 1; }
  done
  [[ "$pr_number" =~ ^[1-9][0-9]*$ && "$base_sha" =~ ^[0-9a-f]{40,64}$ && "$head_sha" =~ ^[0-9a-f]{40,64}$ ]] || {
    finish failed "PR番号またはSHAが不正です"
    return 0
  }
  case "$agent" in
    claude) [[ "$claude_model" =~ ^(fable|opus|sonnet)$ ]] || { finish failed "受け取ったClaudeモデルが不正です: $claude_model"; return 0; } ;;
    codex) [[ "$codex_model" =~ ^[A-Za-z0-9._-]+$ ]] || { finish failed "受け取ったCodexモデルが不正です: $codex_model"; return 0; } ;;
    *) finish failed "受け取った担当が不正です: $agent"; return 0 ;;
  esac

  release_progress_init '["prepare","diff","review","finalize"]'
  release_progress_set prepare 0 "$RUNNING_MESSAGE"
  review_report running "$RUNNING_MESSAGE"
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
    finish failed "対象のコミットを取得できません（base ${base_sha:0:7} / head ${head_sha:0:7}）" \
      "$(diag_payload target_missing "" "" prepare)"
    return 0
  }
  git -C "$LOCAL_PATH" worktree add --detach "$WORKTREE" "$head_sha" >/dev/null 2>&1

  # 差分の材料。ファイルごとの差分を、予算の範囲でバッチへ詰める（#4615）。
  # **入力へ載せることは確認の実績ではない。** 容量を超えた分は次のバッチで確認し、省略・黙った除外はしない
  release_progress_set diff 1 "リリースの差分を取得しています"
  review_report running ""
  mapfile -t files < <(git -C "$WORKTREE" diff --name-only "$base_sha...$head_sha")
  total_files="${#files[@]}"
  if ((total_files == 0)); then
    finish succeeded "差分がありません" \
      "$(jq -nc '{state: "passed", summary: "mainとの差分がありません", findings: [], totalFiles: 0, reviewedFiles: 0, targetFiles: [], fileReviews: [], inputFiles: 0}')"
    return 0
  fi
  find "$WORK_ROOT" -maxdepth 1 -name '*.batches' -mtime +3 -exec rm -rf {} + 2>/dev/null || true
  batch_dir="$WORK_ROOT/${repo}-${pr_number}-${base_sha:0:12}-${head_sha:0:12}-${DIFF_BUDGET_BYTES}.batches"
  mkdir -p "$batch_dir"
  plan_batches
  prs_text="$(git -C "$WORKTREE" log --format='- %s' "$base_sha..$head_sha" | head -n 200)"

  # 再レビューの文脈（#4559）。引き継げるかは、サーバーの判定（base・版・履歴）に、ここで実測した事実
  # （前回の対象を取得できるか・修正と無関係なPRが加わっていないか）を重ねて決める
  ctx_json="$(fetch_review_context)" || ctx_json=""
  if [[ -n "$ctx_json" ]]; then
    ctx_mode="$(jq -r '.mode // "initial"' <<<"$ctx_json")"
    effective_mode="$ctx_mode"
    deny_reason="$(jq -r 'if .mode == "rereview" then "" else (.fullReviewReason // "") end' <<<"$ctx_json")"
    prev_head="$(jq -r '.previous.headSha // ""' <<<"$ctx_json")"
    checklist_version="$(jq -r '.checklistVersion // empty' <<<"$ctx_json")"
    fix_prs_json="$(jq -c '.fixPrNumbers // []' <<<"$ctx_json")"
  fi
  mkdir -p "$WORK_ROOT"
  local fix_files_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.fixfiles"
  local fix_diff_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.fixdiff"
  : >"$fix_files_file"
  : >"$fix_diff_file"
  if [[ "$prev_head" =~ ^[0-9a-f]{40,64}$ ]]; then
    git -C "$LOCAL_PATH" fetch --quiet origin "$prev_head" 2>/dev/null || true
    if git -C "$LOCAL_PATH" cat-file -e "${prev_head}^{commit}" 2>/dev/null; then
      mapfile -t fix_files < <(git -C "$WORKTREE" diff --name-only "$prev_head" "$head_sha" 2>/dev/null)
      fix_diff_count="${#fix_files[@]}"
      printf '%s\n' "${fix_files[@]}" >"$fix_files_file"
      git -C "$WORKTREE" diff "$prev_head" "$head_sha" 2>/dev/null | head -c 100000 >"$fix_diff_file" || true
      mapfile -t added_prs < <(git -C "$WORKTREE" log --merges --format='%s' "$prev_head..$head_sha" 2>/dev/null |
        sed -nE 's/^Merge pull request #([0-9]+).*/\1/p' | sort -un)
      if ((${#added_prs[@]} > 0)); then
        mapfile -t unrelated_prs < <(jq -rn --argjson added "$(printf '%s\n' "${added_prs[@]}" | jq -Rsc 'split("\n") | map(select(. != "") | tonumber)')" \
          --argjson fix "$fix_prs_json" '$added - $fix | .[]')
      fi
      if [[ "$effective_mode" == "rereview" && ${#unrelated_prs[@]} -gt 0 ]]; then
        effective_mode="initial"
        deny_reason="修正と無関係なPR（$(printf '#%s ' "${unrelated_prs[@]}" | sed 's/ $//')）が加わったため、対象全体を確認します"
      fi
    elif [[ "$effective_mode" == "rereview" ]]; then
      effective_mode="initial"
      deny_reason="前回の対象（${prev_head:0:7}）を取得できないため、対象全体を確認します"
    fi
  fi

  prompt_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.prompt"
  output_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.out"
  log_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.log"
  # 差分などの大きな本文は引数・環境変数に載せない（Linuxは1引数128KiBまでで、超えるとexecveが
  # E2BIG＝終了コード126になる。#4316）。ファイルへ書き、Pythonにはパスだけを渡す
  part_dir="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.parts"
  rm -rf "$part_dir"
  mkdir -p "$part_dir"
  printf '%s' "$prs_text" >"$part_dir/prs"
  if [[ -n "$checklist_version" ]]; then
    jq -r '.checklistPrompt // ""' <<<"$ctx_json" >"$part_dir/checklist"
    jq -r '.blockingPolicy // ""' <<<"$ctx_json" >"$part_dir/blocking"
  fi
  local ctx_safe="${ctx_json:-}"
  [[ -n "$ctx_safe" ]] || ctx_safe='{}'
  review_context_text "$ctx_safe" "$effective_mode" "$deny_reason" "$fix_files_file" "$fix_diff_file" >"$part_dir/rereview"
  printf '%s' "${checklist_version:-}" >"$part_dir/version"
  printf '%s' "$effective_mode" >"$part_dir/mode"
  printf '%s' "$(jq -e '.previous != null' <<<"$ctx_safe" >/dev/null 2>&1 && echo yes || echo no)" >"$part_dir/hasprev"

  if [[ "$agent" == "codex" ]]; then
    codex_command="$(agent_cli_codex_command)"
    command -v "$codex_command" >/dev/null 2>&1 || {
      finish failed "Codex CLIが見つかりません" "$(diag_payload launch_failed "" "" review)"
      return 0
    }
  else
    command -v claude >/dev/null 2>&1 || {
      finish failed "claude CLIが見つかりません" "$(diag_payload launch_failed "" "" review)"
      return 0
    }
  fi

  # バッチごとに確認する。保存済みの結果（同じbase・head・予算）は再利用して続きから再開する
  local mode_label executed=0 idx result_file rc remaining=0
  mode_label="$([[ "$effective_mode" == "rereview" ]] && echo 再レビュー || echo 全体確認)"
  for ((idx = 1; idx <= batch_count; idx++)); do
    result_file="$batch_dir/r${idx}.json"
    if [[ -s "$result_file" ]] && jq -e 'type == "object"' "$result_file" >/dev/null 2>&1; then
      continue
    fi
    if ((executed >= MAX_BATCHES_PER_RUN)); then
      remaining=$((remaining + 1))
      continue
    fi
    RUNNING_MESSAGE="全体レビュー（${mode_label}）を実行中です（${agent}・${claude_model:-$codex_model}・バッチ${idx}/${batch_count}・全${total_files}ファイル）"
    release_progress_set review 2 "$RUNNING_MESSAGE" "" "$total_files"
    review_report running "$RUNNING_MESSAGE"
    batch_coverage_text "$idx" >"$part_dir/coverage"
    cp "$batch_dir/b${idx}.diff" "$part_dir/diff"
    build_prompt "$prompt_file" || {
      finish failed "レビュー用のプロンプトを準備できませんでした（AI CLIは起動していません）" \
        "$(diag_payload unknown "" "$ERR_FILE" prepare)"
      return 0
    }
    rm -f "$output_file" "$log_file"
    rc=0
    run_agent "$prompt_file" "$output_file" "$log_file" || rc=$?
    if ((rc != 0)); then
      finish failed "全体レビューを完走できませんでした（バッチ${idx}/${batch_count}・終了コード ${rc}）。完了済みのバッチは保存済みで、再実行すると続きから確認します" \
        "$(diag_payload "$(diag_ai_cause "$rc" "$log_file")" "$rc" "$log_file" review)"
      return 0
    fi
    if ! extract_result_json "$output_file" >"$result_file.tmp" || [[ ! -s "$result_file.tmp" ]]; then
      rm -f "$result_file.tmp"
      finish failed "全体レビューの結果（バッチ${idx}/${batch_count}）をJSONとして読めませんでした" \
        "$(diag_payload parse_failed "" "$output_file" finalize)"
      return 0
    fi
    mv "$result_file.tmp" "$result_file"
    executed=$((executed + 1))
  done

  # 全バッチが済んだら、バッチをまたぐ相互作用を別に確認する（バッチごとの合格の単純集計で済ませない）
  local need_integration=0 int_file="$batch_dir/rint.json"
  ((batch_count > 1)) && need_integration=1
  if ((need_integration == 1 && remaining == 0)) && ! { [[ -s "$int_file" ]] && jq -e 'type == "object"' "$int_file" >/dev/null 2>&1; }; then
    RUNNING_MESSAGE="全体レビュー（${mode_label}）を実行中です（${agent}・${claude_model:-$codex_model}・バッチ間の相互作用を確認・全${total_files}ファイル）"
    release_progress_set review 2 "$RUNNING_MESSAGE" "" "$total_files"
    review_report running "$RUNNING_MESSAGE"
    integration_coverage_text >"$part_dir/coverage"
    integration_digest_text >"$part_dir/diff"
    build_prompt "$prompt_file" || {
      finish failed "レビュー用のプロンプトを準備できませんでした（AI CLIは起動していません）" \
        "$(diag_payload unknown "" "$ERR_FILE" prepare)"
      return 0
    }
    rm -f "$output_file" "$log_file"
    rc=0
    run_agent "$prompt_file" "$output_file" "$log_file" || rc=$?
    if ((rc != 0)); then
      finish failed "全体レビューを完走できませんでした（バッチ間の相互作用の確認・終了コード ${rc}）。バッチごとの結果は保存済みで、再実行すると続きから確認します" \
        "$(diag_payload "$(diag_ai_cause "$rc" "$log_file")" "$rc" "$log_file" review)"
      return 0
    fi
    if ! extract_result_json "$output_file" >"$int_file.tmp" || [[ ! -s "$int_file.tmp" ]]; then
      rm -f "$int_file.tmp"
      finish failed "全体レビューの結果（相互作用の確認）をJSONとして読めませんでした" \
        "$(diag_payload parse_failed "" "$output_file" finalize)"
      return 0
    fi
    mv "$int_file.tmp" "$int_file"
  fi

  release_progress_set finalize 3 "全体レビューの結果を整理しています" "" "$total_files"
  review_report running ""
  # 確認できたファイル数は、AIが根拠つきで報告したファイル別の実績から数える（サーバーが再検証する）。
  # 入力へ載せた数は`inputFiles`として別に報告し、確認の実績とは混ぜない
  local fix_files_json added_json merged_json
  fix_files_json="$(jq -Rsc 'split("\n") | map(select(. != "")) | .[0:300]' <"$fix_files_file" 2>/dev/null || printf '[]')"
  added_json="$(printf '%s\n' "${added_prs[@]:-}" | jq -Rsc 'split("\n") | map(select(. != "") | tonumber)' 2>/dev/null || printf '[]')"
  merged_json="$(merge_batch_results "$remaining")" ||
    { finish failed "全体レビューの結果を整形できませんでした" "$(diag_payload parse_failed "" "" finalize)"; return 0; }
  ai_json="$(jq -c --argjson total "$total_files" \
    --argjson fixFiles "$fix_files_json" --argjson fixCount "$fix_diff_count" --argjson added "$added_json" \
    --arg deny "$deny_reason" \
    '. + {totalFiles: $total, fixDiffFiles: $fixFiles, fixDiffFileCount: $fixCount, addedPullRequests: $added}
      + (if $deny == "" then {} else {fullReviewReason: $deny} end)' <<<"$merged_json")" ||
    { finish failed "全体レビューの結果を整形できませんでした" "$(diag_payload parse_failed "" "" finalize)"; return 0; }
  rm -rf "$part_dir"
  # 最後まで確認できたときだけ保存を消す。残りがあるときは、再実行が続きから確認できるよう残す
  ((remaining == 0)) && rm -rf "$batch_dir"
  finish succeeded "全体レビューを完了しました" "$ai_json"
}

if [[ "${1:-}" == "--run" ]]; then
  shift
  [[ $# -ge 9 ]] || {
    echo "Usage: scripts/run-release-review.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <agent> <claudeモデル> <codexモデル>" >&2
    exit 1
  }
  main "$@"
fi
