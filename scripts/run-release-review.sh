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
# バッチの結果は`*.batches`へ保存し、完走後も残す（#4767）。同じbase・headの再実行は、中断・実行予算で残ったバッチを
# 続きから確認し、証跡に依存する結果だけを証跡の更新後にやり直す（確認済みのバッチは再利用する）。
# **バッチは上限つきで並列に確認する**（#4769）。1本でも失敗したら新しいバッチは起動せず、実行中のものの完了を待って
# 結果を保存してから失敗を報告する（再実行は失敗したバッチから続ける）。
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
# shellcheck source=scripts/lib/release-evidence.sh
source "$SCRIPT_DIR/lib/release-evidence.sh"

WORK_ROOT="${ISSUE_DECK_RELEASE_REVIEW_ROOT:-${TMPDIR:-/tmp}/issue-deck-release-review}"
TIMEOUT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_TIMEOUT_SECONDS:-1800}"
HEARTBEAT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_HEARTBEAT_SECONDS:-60}"
# 1バッチのプロンプトへ入れる差分の上限（文字数）。超えた分は次のバッチへ送る。1ファイルが超えるときは分割する
# 1回の起動で実行するバッチ数の上限（実行予算）。残りは保存して、再実行が続きから確認する（#4615）
DIFF_BUDGET_BYTES="${ISSUE_DECK_RELEASE_REVIEW_DIFF_BUDGET_BYTES:-300000}"
MAX_BATCHES_PER_RUN="${ISSUE_DECK_RELEASE_REVIEW_MAX_BATCHES_PER_RUN:-8}"
# 保存（`*.batches`）の掃除。3日より古いものに加え、新しい順にこの件数を超えた分を消す（ディスクを使い切らない。#4767）
KEEP_BATCH_DIRS="${ISSUE_DECK_RELEASE_REVIEW_KEEP_BATCH_DIRS:-20}"
# 実行結果（テスト・型検査・ビルド）の証跡を指す文言。`src/lib/release-review-reevaluation.ts`の`EVIDENCE_TEXT`と揃える
EVIDENCE_TEXT_PATTERN='統合検証|検証結果|検証証跡|証跡|実行結果|テスト|型検査|ビルド|running|連携先|資料未取得|権限不足|通信失敗|実設定不足|資料にありません|固定SHA|適用手順|デプロイ設定'
# 実行ホスト（サブPCのpoller）の稼働状態を指す文言（#4799）。`src/lib/release-review-reevaluation.ts`の`HOST_TEXT`と揃える
HOST_TEXT_PATTERN='poller|ポーラー|サブPC|再起動|実機|起動時|実行ホスト|稼働コミット|host_compat'
# 同時に確認するバッチ数の上限（#4769）。1で従来どおり1本ずつ。相互作用の確認・実績の補完は全バッチの後に1本だけ走る
PARALLEL="${ISSUE_DECK_RELEASE_REVIEW_PARALLEL:-3}"
# AI 1回の呼び出しのターン数の上限（claudeの`--max-turns`。#4769）。0で上限なし。上限に達すると診断は`turn_limit`になる。
# Codex CLIの`exec`にはターン数を指定する引数が無いため、Codexは従来どおり時間（`TIMEOUT_SECONDS`）だけで止める
MAX_TURNS="${ISSUE_DECK_RELEASE_REVIEW_MAX_TURNS:-300}"
# `turn_limit`で失敗したバッチだけを1回やり直すときの、ターン数と時間の上限（#4785）。ターン数だけ上げても
# 時間（`TIMEOUT_SECONDS`）に先に当たると`timeout`へ置き換わるだけなので、時間も合わせて引き上げる
RETRY_MAX_TURNS="${ISSUE_DECK_RELEASE_REVIEW_RETRY_MAX_TURNS:-500}"
RETRY_TIMEOUT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_RETRY_TIMEOUT_SECONDS:-3000}"
# ファイル別の実績の取りこぼし（報告なし・根拠が空）を補う質問（#4768）。1回の起動で1回まで、対象のファイル数と時間に上限を置く
SUPPLEMENT_MAX_FILES="${ISSUE_DECK_RELEASE_REVIEW_SUPPLEMENT_MAX_FILES:-40}"
SUPPLEMENT_TIMEOUT_SECONDS="${ISSUE_DECK_RELEASE_REVIEW_SUPPLEMENT_TIMEOUT_SECONDS:-600}"
# AIが報告したパスを差分のパスへ揃える（#4768）。区切りを`/`へ、作業ディレクトリの絶対パス・先頭の`./`・`/`を除く。
# `src/lib/release-review-result.ts`の`normalizeReviewPath`と同じ規則（作業ディレクトリの除去はランナーだけ）
JQ_NPATH='def npath($wt): tostring | gsub("\\\\"; "/") | (if $wt != "" and startswith($wt + "/") then .[($wt | length) + 1:] else . end) | gsub("/(\\./)+"; "/") | gsub("/+"; "/") | sub("^(\\./|/)+"; "");'

JOB_ID=""
JOB_REPORTED=0
RUNNING_MESSAGE="全体レビューを準備しています"
HEARTBEAT_PID=""
WORKTREE=""
LOCAL_PATH=""
ERR_FILE=""
part_dir=""
# 並列に起動したバッチのプロセス（#4769）。想定外の終了で`cleanup`が止める
BATCH_PIDS=()

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

# diag_ai_cause <終了コード> <ログ> [最終応答]: AI CLIが非0で終わったときの原因。事実が無ければ unknown。
# ターン数の上限（#4769）は、claudeが最終応答（標準出力）へ`Error: Reached max turns (N)`と書いて1で終わる。
# **claude CLI自身の出力の形（最後の非空行が行頭からこの1行）だけで判定する**（#4785）。レビュー本文に引用された
# 文字列では判定しない（本文の途中・末尾20行のどこかに当たるだけでは`turn_limit`にしない）
diag_ai_cause() {
  local code="$1" log="$2" out="${3:-}" f
  case "$code" in
    124 | 137) printf 'timeout'; return ;;
    126 | 127) printf 'launch_failed'; return ;;
  esac
  for f in "$log" "$out"; do
    if [[ -n "$f" && -s "$f" ]] && [[ "$(grep -v '^[[:space:]]*$' "$f" | tail -n 1)" =~ ^Error:\ Reached\ max\ turns(\ \([0-9]+\))?\.?[[:space:]]*$ ]]; then
      printf 'turn_limit'
      return
    fi
  done
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

# kill_tree <PID>: プロセスとその子孫を止める（並列のバッチの`timeout`・AI CLIを残さない。#4769）
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
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
  local pid
  for pid in "${BATCH_PIDS[@]}"; do
    kill_tree "$pid"
  done
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

1. **前回の止める指摘ごとに**、解消したか（`resolved`・根拠必須）／未解消か（`unresolved`）を確認し、`previousFindings`へ出力する。未解消のものは`findings`にも`previousId`つきで入れる（止める条件を満たしていれば`"blocking": true`と根拠を付ける）
2. 修正差分と、それが影響する呼び出し元・関連機能を再確認する。**修正で新しく生じた問題があれば新規の指摘として出す**。新規の指摘には`discovery`を付ける（修正の結果生じた＝`fix_induced`、前回も見えたはずの見落とし＝`initial_miss`、今回の対象に追加された変更＝`scope_added`、判断できない＝`unknown`）。**修正差分に関係しない`initial_miss`は止めない提案（`"blocking": false`）にする**（認証・認可・データ境界・機密の露出〈`checkId`が`auth_boundary`〉は除く。修正差分のファイルを指していない・根拠で挙げていない`initial_miss`は、サーバー側でも提案へ降格する）
3. 修正差分の影響を受けない確認項目は、前回の結果を引き継いでよい（`"source": "carried_over"`）。**根拠には「なぜ今回の対象にも当てはまるか」を書く**。影響を受ける項目、前回に`unconfirmed`だった項目は今回確認する（`"source": "current"`）
4. 再確認した範囲と、その範囲を選んだ理由を`recheckScope`に書く
5. **前回に無かった重大な問題でも、見つけたら必ず報告する。** 前回未指摘であることを理由に無視しない

再レビューは合格の保証ではありません。現在の対象で必須項目に未確認が無く、止める指摘が無いときだけ合格です。
RULES
  fi
}

# review_decisions_text <context JSON>
# ユーザーが指摘ごとに付けた判断（#4657）の節を標準出力へ。判断が無ければ何も出さない（旧サーバーも同じ）
review_decisions_text() {
  local ctx="$1"
  jq -e '(.decisions // []) | length > 0' <<<"$ctx" >/dev/null 2>&1 || return 0
  printf '\n## ユーザーの判断（指摘ごとの採否・対応時期）\n\n'
  printf '次の指摘は、影響と根拠を見たうえでユーザーが採否・対応時期を決めています。**判断済みの指摘を、言い換えや重大度の付け直しだけで新しい指摘として出し直さないでください。**\n\n'
  jq -r '.decisions[] | "- `\(.id)` \(.title) — **\({"fix_now":"今回直す","post_release":"公開後に対応する","defer":"今回は見送る","reject":"指摘を採用しない"}[.decision])**（理由: \(.reason[0:300])\(if .impact then "／残る影響: \(.impact[0:200])" else "" end)\(if .scope then "／対象範囲: \(.scope[0:200])" else "" end)\(if .timing then "／実施時期: \(.timing[0:100])" else "" end)\(if .followUp then "／関連Issue: \(.followUp)" else "" end)）\(if .stale then "［判断後にmainが進んだため、前提の確認が必要］" else "" end)"' <<<"$ctx"
  cat <<'RULES'

- 同じ問題が今回も残っていれば、`findings`へ**`previousId`に上の指摘IDを付けて**入れてください（IDが変わると判断が外れ、ユーザーが同じ判断をやり直すことになります）
- 判断の前提（対象差分・影響の範囲・判断の根拠になった事実）が今回の差分で変わった場合だけ、その指摘に`premiseChanged`として**何が変わったか**を書いてください。前提が変わっていなければ`premiseChanged`を付けません
- 「公開後に対応する」と判断された作業（例: 本番公開後の共有タグ配布）を、同じ本体の公開前の完了条件として求め直さないでください
RULES
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
`unverifiedScope`は**リリース全体として最後に残る未確認範囲だけ**を書きます（無ければ`null`）。この値がバッチごとの「未確認範囲」に置き換わります。
バッチの時点で書かれた「他のバッチ・相互作用は未確認」は、全バッチとこの確認が済んだので書き写しません。バッチの未確認範囲のうち、他のバッチ・この確認・実行ホストの稼働情報で解消したものも落とし、解消できなかったものだけを理由とともに残します。
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
      ((.checks // []) | .[] | "- `\(.id)` \(.status): \((.evidence // "")[0:200])"),
      "未確認範囲: \((.unverifiedScope // "なし") | tostring | .[0:600])"' "$batch_dir/r${idx}.json"
    printf '\n'
  done
}

# missing_file_pairs: 保存済みのバッチ結果のうち、載せたファイルの実績が無い・根拠が空のものを
# `$batch_dir/sup.pairs`（ファイル<TAB>バッチ番号）へ書く（#4768）。取得不能（unreadable）と報告されたものは補完しない
missing_file_pairs() {
  local idx
  : >"$batch_dir/sup.pairs"
  for ((idx = 1; idx <= batch_count; idx++)); do
    [[ -s "$batch_dir/r${idx}.json" ]] || continue
    jq -r --arg wt "$WORKTREE" --arg idx "$idx" --rawfile files "$batch_dir/b${idx}.files" "$JQ_NPATH"'
      [ (.fileReviews // [])[] | select(type == "object")
        | {p: ((.file // "") | npath($wt)), s: .status, e: ((.evidence // "") | tostring)} ] as $rv
      | $files | split("\n") | map(select(. != "") | split("\t")[0]) | unique[]
      | . as $f
      | select(all($rv[]; .p != $f or (.s != "unreadable" and ((.s == "reviewed" and (.e | test("\\S"))) | not))))
      | "\($f)\t\($idx)"' "$batch_dir/r${idx}.json" >>"$batch_dir/sup.pairs" 2>/dev/null || true
  done
}

# plan_supplement: 補完の対象（`sup.files`）と差分（`sup.diff`）を作る。ファイル数は`SUPPLEMENT_MAX_FILES`、差分は
# `DIFF_BUDGET_BYTES`まで。分割したファイルは取りこぼした断片だけを載せる。入らなかったファイルは補完せず未確認に残す
plan_supplement() {
  local file idx part text used=0 n=0
  : >"$batch_dir/sup.files"
  : >"$batch_dir/sup.diff"
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    ((n < SUPPLEMENT_MAX_FILES)) || break
    text=""
    while IFS= read -r idx; do
      part="$(awk -F'\t' -v f="$file" '$1 == f {print $2; exit}' "$batch_dir/b${idx}.files")"
      if [[ -n "$part" ]]; then
        text+="$(cat "$batch_dir/b${idx}.diff")"$'\n'
      else
        text+="$(git -C "$WORKTREE" diff "$base_sha...$head_sha" -- "$file" 2>/dev/null || true)"$'\n'
      fi
    done < <(awk -F'\t' -v f="$file" '$1 == f {print $2}' "$batch_dir/sup.pairs")
    ((used + ${#text} <= DIFF_BUDGET_BYTES)) || continue
    printf '%s' "$text" >>"$batch_dir/sup.diff"
    printf '%s\n' "$file" >>"$batch_dir/sup.files"
    used=$((used + ${#text}))
    n=$((n + 1))
  done < <(cut -f1 "$batch_dir/sup.pairs" | awk '!seen[$0]++')
}

# supplement_coverage_text: 取りこぼしたファイルだけを聞き直す指示（#4768）
supplement_coverage_text() {
  printf '**これはファイル別の確認実績の補完です。** バッチごとの確認で、次のファイルの確認実績（`fileReviews`）が報告されなかったか、根拠が空でした。下の差分には、このファイルの分だけを載せています（分割したファイルは取りこぼした断片だけ）:\n%s\n\n' \
    "$(sed 's/^/- /' "$batch_dir/sup.files")"
  cat <<'RULES'
上のファイルそれぞれについて、差分を読み、必要なら周辺コードも確認したうえで、`fileReviews`へ
`{"file": "上に書いたとおりのパス", "status": "reviewed", "evidence": "読んだ箇所・確認した内容"}`を出します。
読めなかった・確認しきれなかったファイルは`"status": "unreadable"`にし、理由を`evidence`へ書きます。根拠の無い`reviewed`は確認済みとして数えません。
確認項目（`checks`）はバッチごとに記録済みなので、**空配列にしてください**。新たに見つけた問題があれば`findings`へ入れます（無ければ空配列）。
RULES
}

# build_prompt <出力先> [部品のディレクトリ]: 部品（coverage・diff・prs・checklist…。既定は`$part_dir`）からプロンプトを組み立てる
build_prompt() {
  local out="$1" parts="${2:-$part_dir}"
  python3 - "$SCRIPT_DIR/prompts/release-review-agent.md" "$out" "$full_name" "$pr_number" "$base_sha" "$head_sha" \
    "$parts" <<'PY'
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
has_decisions = part("hasdecisions").strip() == "yes"
if version:
    checklist, blocking = part("checklist"), part("blocking")
else:
    # サーバーから確認項目を取れなかったとき（旧サーバー・通信失敗）。項目別の記録は出せない
    checklist = "（確認項目を取得できませんでした。リリース全体として上の観点を確認してください）"
    blocking = ""
repl = {
    "{{REPOSITORY}}": repo, "{{PR_NUMBER}}": pr, "{{BASE_SHA}}": base, "{{HEAD_SHA}}": head,
    "{{VERIFICATION_EVIDENCE}}": part("evidence"),
    "{{COVERAGE}}": part("coverage"), "{{PULL_REQUESTS}}": part("prs"), "{{DIFF}}": part("diff"),
    "{{CHECKLIST_VERSION}}": version or "0",
    "{{CHECKLIST}}": checklist, "{{BLOCKING_POLICY}}": blocking, "{{REREVIEW}}": part("rereview"),
    "{{CHECK_SOURCE_HINT}}": ', "source": "current|carried_over"' if mode == "rereview" else "",
    "{{FINDING_HINT}}": ', "previousId": "前回の指摘ID（同じ指摘の再発のとき）", "discovery": "fix_induced|initial_miss|scope_added|unknown（新規のとき）", "stallCause": "unfixed|fix_ineffective|verification_insufficient|execution_failure|unknown（再発のとき）"' + (', "premiseChanged": "判断済みの指摘で、判断の前提が変わったときだけ何が変わったか"' if has_decisions else "") if has_prev else ', "previousId": "ユーザーが判断済みの指摘ID（同じ指摘のとき）", "premiseChanged": "判断済みの指摘で、判断の前提が変わったときだけ何が変わったか"' if has_decisions else "",
    "{{REREVIEW_FIELDS}}": ',\n  "previousFindings": [ { "id": "前回の指摘ID", "status": "resolved|unresolved", "evidence": "解消または未解消の根拠" } ],\n  "recheckScope": "再確認した範囲と選んだ理由"' if has_prev else "",
}
for key, value in repl.items():
    text = text.replace(key, value)
open(out, "w", encoding="utf-8").write(text)
PY
}

# run_agent <プロンプト> <出力> <ログ> [制限秒] [ターン数の上限]: AI CLIを読み取り専用で1回実行する。終了コードを返す
run_agent() {
  local prompt="$1" out="$2" log="$3" limit="${4:-$TIMEOUT_SECONDS}" max_turns="${5:-$MAX_TURNS}"
  if [[ "$agent" == "codex" ]]; then
    local -a codex_args=(exec --sandbox read-only --ephemeral -m "$codex_model" --output-schema "$SCRIPT_DIR/prompts/release-review-result.schema.json" --output-last-message "$out" -C "$WORKTREE")
    (cd "$WORKTREE" && timeout -k 60 "$limit" "$codex_command" "${codex_args[@]}" <"$prompt" >"$log" 2>&1)
  else
    local -a claude_args=(-p --model "$claude_model" --allowedTools Read Grep Glob)
    [[ "$max_turns" =~ ^[1-9][0-9]*$ ]] && claude_args+=(--max-turns "$max_turns")
    (cd "$WORKTREE" && timeout -k 60 "$limit" claude "${claude_args[@]}" <"$prompt" >"$out" 2>"$log")
  fi
}

# runner_host_prompt_text <owner/repo> <head SHA>: 実行ホスト（このランナーを起動したサブPCのpoller）の稼働情報の節（#4665）
# 「pollerの更新・再起動の証跡が無い」だけで項目を未確認にし、同じ更新要求が再レビューで繰り返されていたため、
# 確認できる事実（いま走っているpollerの版・候補を含むか）を渡す。**確認できないものは「確認できない」と書く**
runner_host_includes() {
  local full_name="$1" head="$2" root started includes="確認できない"
  root="$(cd "$SCRIPT_DIR/.." && pwd)"
  started="${POLLER_STARTED_COMMIT:-}"
  if [[ "$full_name" == "guchi-apps/issue-deck" && -n "$started" ]]; then
    if git -C "$root" merge-base --is-ancestor "$head" "$started" 2>/dev/null; then
      includes="含む（候補の変更はこのpollerで既に動いている）"
    elif git -C "$root" cat-file -e "${head}^{commit}" 2>/dev/null; then
      includes="含まない（pollerは候補より古い版で動いている）"
    fi
  elif [[ "$full_name" != "guchi-apps/issue-deck" ]]; then
    includes="対象外（pollerのコードはguchi-apps/issue-deckにあり、この候補はpollerを変えない）"
  fi
  printf '%s' "$includes"
}

# runner_host_fingerprint <owner/repo> <head SHA>: ホストの事実（起動時のコミット・候補を含むか）の指紋（#4799）。
# チェックアウトの現在のHEADは含めない（無関係なコミットで保存済みの結果が古くならないように）
runner_host_fingerprint() {
  printf '%s|%s' "${POLLER_STARTED_COMMIT:-}" "$(runner_host_includes "$1" "$2")"
}

runner_host_prompt_text() {
  local full_name="$1" head="$2" root started current includes
  root="$(cd "$SCRIPT_DIR/.." && pwd)"
  started="${POLLER_STARTED_COMMIT:-}"
  current="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || true)"
  includes="$(runner_host_includes "$full_name" "$head")"
  printf '\n## 実行ホストの稼働情報（このレビューを起動したサブPCのpoller）\n\n'
  printf -- '- いま走っているpollerの版（起動時のコミット）: %s\n' "${started:-確認できない（申告の無い旧poller）}"
  printf -- '- チェックアウトの現在のHEAD: %s\n' "${current:-確認できない}"
  printf -- '- 起動時のコミットが候補headを含むか: %s\n\n' "$includes"
  printf '`host_compat`では、**コードの互換性**（旧pollerと新サーバー、新pollerと旧サーバーで動くか）と**実機の更新**（サブPCのpollerを更新・再起動する必要があるか）を分けて書きます。実機の更新が要ると書くのは、この候補にサブPCへ届く変更（`scripts/`など）があり、上の稼働情報で候補を含まないと分かる場合か、旧版のpollerでは動かない（非互換）と根拠を示せる場合だけです。サーバーへのデプロイだけで有効になる変更・互換性を確認できた変更に、更新・再起動を求めません。上の稼働情報で「含む」と分かっていれば、更新済みとして扱います。実機の更新が必要なときは、公開（mainへのマージ）の前に必要か公開後でよいかと、その理由を書きます。\n'
}

# result_depends_on_evidence <結果JSON>: その結果が統合検証の証跡（結果待ち・未確認）に左右されているか（#4632・#4767）
# **証跡を指す文言の未確認だけを依存に数える**（`reviewDependsOnEvidence`と同じ規則）。根拠の無い未確認は、何に
# 依存するか分からないので依存側へ倒す。poller更新のような運用の未確認・コードの未読は、証跡が更新されても変わらない
result_depends_on_evidence() {
  # 連携先の証跡を取得できた候補では、旧文言の未確認も含め全ての未確認を連携先の証跡の更新に依存させる（#4975）
  if [[ "${INTEGRATION_EVIDENCE_ACTIVE:-0}" == 1 ]]; then
    jq -e 'any(.checks[]?; .status == "unconfirmed") or ((.unverifiedScope // "") | tostring | length > 0)' "$1" >/dev/null 2>&1 && return 0
  fi
  jq -e --arg re "$EVIDENCE_TEXT_PATTERN" '
    any(.checks[]?; .status == "unconfirmed" and (((.evidence // "") | tostring) as $e | $e == "" or ($e | test($re; "i"))))
    or ((.unverifiedScope // "") | tostring | test($re; "i"))' "$1" >/dev/null 2>&1
}

# result_depends_on_host <結果JSON>: その結果が実行ホストの運用状態（pollerの更新・再起動）の未確認を持つか（#4799）
# 未確認の項目の根拠・未確認範囲が`HOST_TEXT_PATTERN`に当たるものだけ（`reviewDependsOnHost`と同じ規則）
result_depends_on_host() {
  jq -e --arg re "$HOST_TEXT_PATTERN" '
    any(.checks[]?; .status == "unconfirmed" and ((.evidence // "") | tostring | test($re; "i")))
    or ((.unverifiedScope // "") | tostring | test($re; "i"))' "$1" >/dev/null 2>&1
}

# invalidate_stale_batches <現在の証跡の指紋> [現在の確認項目の版]: 保存済みの結果のうち、やり直すものを捨てる（#4632・#4767）。
# やり直すのは「証跡に依存し、かつ保存時と指紋が違う（どちらかが取れない）」結果と、確認項目の版が今と違う結果だけ。
# それ以外（確認済み・証跡に依存しない未確認）は再利用する。相互作用の確認（`rint`）・実績の補完（`rsup`。#4768）も
# 同じ規則で捨てるほか、バッチを1つでもやり直すときは実行後に必ずやり直す（main側で捨てる）。
# 結果は`reuse_note`へ（画面のメッセージ用）。`batch_dir`は呼び出し元（main）のローカル変数を参照する
invalidate_stale_batches() {
  local cur_fp="$1" cur_ver="${2:-}" cur_hfp="${3:-}" f stem saved dropped=0 reused=0 dep_ev dep_host stale
  reuse_note=""
  for f in "$batch_dir"/r*.json; do
    [[ -e "$f" ]] || continue
    stem="${f%.json}"
    if [[ -n "$cur_ver" ]] && ! jq -e --arg v "$cur_ver" '(.checklistVersion // "" | tostring) == $v' "$f" >/dev/null 2>&1; then
      rm -f "$f" "$stem.fp" "$stem.hfp"
      [[ "$f" == */rint.json || "$f" == */rsup.json ]] || dropped=$((dropped + 1))
      continue
    fi
    dep_ev=0
    dep_host=0
    result_depends_on_evidence "$f" && dep_ev=1
    # 運用の未確認は、ホストの事実（起動時コミット・候補を含むか）が保存時と変わったら見直す（#4799）
    [[ -n "$cur_hfp" ]] && result_depends_on_host "$f" && dep_host=1
    if ((dep_ev == 0 && dep_host == 0)); then
      [[ "$f" == */rint.json || "$f" == */rsup.json ]] || reused=$((reused + 1))
      continue
    fi
    stale=0
    if ((dep_ev == 1)); then
      saved="$(cat "$stem.fp" 2>/dev/null || true)"
      [[ -n "$cur_fp" && -n "$saved" && "$saved" == "$cur_fp" ]] || stale=1
    fi
    if ((dep_host == 1)); then
      saved="$(cat "$stem.hfp" 2>/dev/null || true)"
      [[ -n "$saved" && "$saved" == "$cur_hfp" ]] || stale=1
    fi
    if ((stale == 0)); then
      [[ "$f" == */rint.json || "$f" == */rsup.json ]] || reused=$((reused + 1))
      continue
    fi
    rm -f "$f" "$stem.fp" "$stem.hfp"
    [[ "$f" == */rint.json || "$f" == */rsup.json ]] || dropped=$((dropped + 1))
  done
  if ((dropped > 0)); then
    rm -f "$batch_dir/rint.json" "$batch_dir/rint.fp" "$batch_dir/rint.hfp" "$batch_dir/rsup.json" "$batch_dir/rsup.fp" "$batch_dir/rsup.hfp"
    reuse_note="（検証証跡・実行ホストの状態が更新されたため、それに依存する${dropped}件を再評価します。確認済みの${reused}件は再利用）"
  fi
}

# prune_batch_dirs: 古い保存（`*.batches`）を消す。3日より古いものと、新しい順に`KEEP_BATCH_DIRS`件を超えた分（#4767）。
# 使用中の保存は直前に`touch`して最新にしてから呼ぶ
prune_batch_dirs() {
  local keep="$KEEP_BATCH_DIRS" d n=0
  find "$WORK_ROOT" -maxdepth 1 -name '*.batches' -mtime +3 -exec rm -rf {} + 2>/dev/null || true
  [[ "$keep" =~ ^[0-9]+$ ]] && ((keep >= 1)) || keep=1
  while IFS= read -r d; do
    [[ -n "$d" ]] || continue
    n=$((n + 1))
    if ((n > keep)); then rm -rf "$d"; fi
  done < <(ls -1dt "$WORK_ROOT"/*.batches 2>/dev/null || true)
}

# merge_batch_results <未実施のバッチ数>: 保存済みのバッチ結果（と相互作用の確認・実績の補完）を1つの結果へまとめる。
# 確認項目は、**相互作用の確認が根拠つきで報告した結果を優先する**（バッチをまたいでリリース全体として判断したもの。#4768）。
# 相互作用の確認が無い・報告していない項目は、全バッチが根拠つきの確認済み・非該当を報告したときだけ確認済みにする
# （確認済みと非該当が混ざれば確認済み）。報告の無いバッチ・未確認と報告したバッチが残れば、その理由を添えて未確認にする。
# ファイルは、含まれる全バッチ（巨大ファイルは全断片）で根拠つきの`reviewed`が揃ったもの、または補完で根拠つきの
# `reviewed`が報告されたものだけを確認済みとして出す。AIが報告したパスは`npath`で差分のパスへ揃えてから照合する
merge_batch_results() {
  local pending="$1" reused="${2:-0}" rerun="${3:-0}" int_reused="${4:-false}" idx
  local -a batch_results=() all_results=() batch_idxs=()
  for ((idx = 1; idx <= batch_count; idx++)); do
    if [[ -s "$batch_dir/r${idx}.json" ]]; then
      batch_results+=("$batch_dir/r${idx}.json")
      batch_idxs+=("$idx")
    fi
  done
  all_results=("${batch_results[@]}")
  [[ -s "$batch_dir/rint.json" ]] && all_results+=("$batch_dir/rint.json")
  local targets_json expected_json runner_json idxs_json sup_json='{}' sup_findings='[]'
  targets_json="$(printf '%s\n' "${files[@]}" | jq -Rsc 'split("\n") | map(select(. != ""))')"
  expected_json="$(cut -f1 "$batch_dir"/b*.files 2>/dev/null | jq -Rsc 'split("\n") | map(select(. != "")) | group_by(.) | map({key: .[0], value: length}) | from_entries')"
  runner_json="$(jq -sc '.' "$batch_dir/runner.entries" 2>/dev/null || printf '[]')"
  idxs_json="$(printf '%s\n' "${batch_idxs[@]:-}" | jq -Rsc 'split("\n") | map(select(. != "") | tonumber)')"
  [[ ${#all_results[@]} -gt 0 ]] || { printf '{"state":"passed","targetFiles":%s,"fileReviews":%s,"inputFiles":0,"batches":%d,"pendingBatches":%d,"reusedBatches":0,"rerunBatches":0}' "$targets_json" "$runner_json" "$batch_count" "$pending"; return 0; }
  # 補完の結果は、聞き直したファイルの分だけを使う
  if [[ -s "$batch_dir/rsup.json" && -s "$batch_dir/rsup.asked" ]]; then
    sup_json="$(jq -c --arg wt "$WORKTREE" --rawfile asked "$batch_dir/rsup.asked" "$JQ_NPATH"'
      ($asked | split("\n") | map(select(. != ""))) as $a
      | [ (.fileReviews // [])[] | select(type == "object")
          | {file: ((.file // "") | npath($wt)), status, evidence: ((.evidence // "") | tostring)}
          | select(.file as $f | any($a[]; . == $f)) ]
      | group_by(.file) | map({key: .[0].file, value: .}) | from_entries' "$batch_dir/rsup.json" 2>/dev/null || printf '{}')"
    sup_findings="$(jq -c '[(.findings // [])[] | select(type == "object")]' "$batch_dir/rsup.json" 2>/dev/null || printf '[]')"
  fi

  local file_reviews
  file_reviews="$( ((${#batch_results[@]} > 0)) && jq -sc --argjson expected "$expected_json" --argjson runner "$runner_json" \
    --argjson sup "$sup_json" --arg wt "$WORKTREE" "$JQ_NPATH"'
      def has_ev: (.evidence // "") | tostring | test("\\S");
      . as $rs
      | ($expected | to_entries | map(
          .key as $f | .value as $n
          | [ $rs[] | (.fileReviews // []) | map(select(type == "object" and ((.file // "") | npath($wt)) == $f)) ] as $per
          | [ $per[][] | select(.status == "unreadable") ] as $bad
          | [ $per[] | map(select(.status == "reviewed" and has_ev)) | select(length > 0) | .[0] ] as $ok
          | ($sup[$f] // []) as $s
          | [ $s[] | select(.status == "reviewed" and has_ev) ] as $sok
          | if ($bad | length) > 0 then {file: $f, status: "unreadable", evidence: (($bad[0].evidence // "確認できませんでした") | tostring | .[0:300])}
            elif ($ok | length) >= $n then {file: $f, status: "reviewed", evidence: ($ok | map(.evidence | tostring) | join(" / ") | .[0:480])}
            elif ($sok | length) > 0 then {file: $f, status: "reviewed", evidence: ("補完で確認: " + $sok[0].evidence | .[0:480]), supplemented: true}
            elif ([ $s[] | select(.status == "unreadable") ] | length) > 0 then {file: $f, status: "unreadable", evidence: ((first($s[] | select(.status == "unreadable")).evidence // "確認できませんでした") | .[0:300])}
            else empty end
        )) + $runner' "${batch_results[@]}" || printf '%s' "$runner_json")"

  jq -sc --argjson pending "$pending" --argjson targets "$targets_json" \
    --argjson fileReviews "$file_reviews" --argjson inputFiles "$input_files" --argjson batches "$batch_count" \
    --argjson reused "$reused" --argjson rerun "$rerun" --argjson intReused "$int_reused" \
    --argjson nb "${#batch_results[@]}" --argjson idxs "$idxs_json" --argjson supFindings "$sup_findings" '
    . as $rs
    | def uniq_by_key: group_by([((.title // "") | ascii_downcase | gsub("[\\s\\p{P}\\p{S}]"; "")), .file]) | map(sort_by(if .blocking == false then 1 else 0 end) | .[0]);
      def has_ev: (.evidence // "") | tostring | test("\\S");
      def settled: (.status == "confirmed" or .status == "not_applicable") and has_ev;
    ($rs[:$nb]) as $br
    | ($rs[$nb:]) as $ir
    | {
      state: (if any($rs[]; .state == "needs_check") or any($rs[], {findings: $supFindings}; (.findings // []) | any(.blocking == true)) then "needs_check" else "passed" end),
      summary: ([ $rs | to_entries[] | . as $e | ($e.value.summary // "") | select(. != "") | "[\(if $e.key < $nb then "バッチ\($idxs[$e.key])" else "相互作用の確認" end)] \(.[0:1500])" ] | join("\n") | .[0:19000]),
      checklistVersion: ([ $rs[] | .checklistVersion // empty ] | first),
      checks: (
        [ $rs[] | (.checks // [])[] | select(type == "object") | .id ] | unique | map(
          . as $id
          | ([ $ir[] | (.checks // [])[] | select(type == "object" and .id == $id) ] | first) as $ic
          | [ $br[] | ([ (.checks // [])[] | select(type == "object" and .id == $id) ] | first) ] as $per
          # 実際のバッチ番号で引く（`$per`は保存済みの結果の並びで、結果の無いバッチを詰めている）
          | ($per | to_entries | map({key: ($idxs[.key] | tostring), value: .value}) | from_entries) as $pm
          | [ range(1; $batches + 1) as $b | ($pm[$b | tostring] // null) as $c
              | select($c == null or ($c | settled | not))
              | "\(if $batches > 1 then "バッチ\($b): " else "" end)\(if $c == null then "報告がありません（未実施または報告の無いバッチ）" else ($c.evidence // "根拠が報告されていません" | tostring | if test("\\S") then .[0:300] else "根拠が報告されていません" end) end)" ] as $open
          | if $ic != null and ($ic.status == "confirmed" or $ic.status == "not_applicable" or $ic.status == "unconfirmed") and ($ic | has_ev) then
              # バッチ側の未確認を上書きしたときは、その根拠も併記する（何を相互作用の確認で解消とみなしたかを追えるように）
              {id: $id, status: $ic.status,
               evidence: ("[相互作用の確認] \($ic.evidence)"
                 + (if $ic.status != "unconfirmed" and ($open | length) > 0 then "／バッチ側の未確認: \($open | join(" / "))" else "" end) | .[0:1400]),
               source: ($ic.source // "current")}
            else
              if ($open | length) > 0 then
                  {id: $id, status: "unconfirmed", evidence: ($open | join(" / ") | .[0:1400])}
                else
                  {id: $id, status: (if any($per[]; .status == "confirmed") then "confirmed" else "not_applicable" end),
                   evidence: ($per | map(.evidence | tostring) | join(" / ") | .[0:1400]),
                   source: (if all($per[]; .source == "carried_over") then "carried_over" else "current" end)}
                end
            end)),
      # 相互作用の確認があれば、その未確認範囲を全体の値にする（#4799）。全バッチの後にバッチの未確認範囲を読んで
      # 解消・残存を判断したもので、バッチの時点の「他のバッチは未確認」を持ち越さない
      unverifiedScope: ((if ($ir | length) > 0 then [ $ir[] | .unverifiedScope // empty ] else [ $rs[] | .unverifiedScope // empty ] end)
        | map(tostring | select(test("\\S"))) | join(" / ") | if . == "" then null else .[0:1900] end),
      findings: ([ ($rs[] | (.findings // [])[]), $supFindings[] ] | uniq_by_key | .[0:50]),
      affectedPullRequests: ([ $rs[] | (.affectedPullRequests // [])[] ] | unique),
      affectedFiles: ([ $rs[] | (.affectedFiles // [])[] ] | unique | .[0:200]),
      previousFindings: ([ $rs[] | (.previousFindings // [])[] ] | group_by(.id) | map(
        (map(select(.status == "unresolved")) | first) // (map(select(.status == "resolved" and ((.evidence // "") | length) > 0)) | first) // .[0])),
      recheckScope: ([ $rs[] | .recheckScope // empty ] | join(" / ") | if . == "" then null else .[0:1400] end),
      targetFiles: $targets,
      fileReviews: $fileReviews,
      supplementedFiles: ([ $fileReviews[] | select(.supplemented == true) ] | length),
      inputFiles: $inputFiles,
      batches: $batches,
      pendingBatches: $pending,
      reusedBatches: $reused,
      rerunBatches: $rerun,
      integrationReused: (if $batches > 1 then $intReused else null end)
    }
    | with_entries(select(.value != null))' "${all_results[@]}"
}

# batch_running_label <実行中のバッチ番号…>: 進捗の文面の「バッチ2/5」「バッチ2・3/5を並列で確認中」の部分（#4769）
batch_running_label() {
  if (($# <= 1)); then
    printf 'バッチ%s/%s' "${1:-?}" "$batch_count"
  else
    local joined="$1" i
    for i in "${@:2}"; do joined+="・$i"; done
    printf 'バッチ%s/%sを並列で確認中' "$joined" "$batch_count"
  fi
}

# batch_progress_message <モード> <agent> <モデル> <実施済み> <再利用> <失敗数> <全ファイル数> <実行中のバッチ番号…>:
# 進捗の文面。分母は全バッチ数（`batch_count`）に揃え、完了は再利用を含めて数える（「完了2/5（再利用1）」。#4785）。
# 失敗したバッチがあるときは、新しいバッチを起動せず実行中のものの完了を待っているので、その旨を出す
batch_progress_message() {
  local mode="$1" ag="$2" model="$3" executed="$4" reused="$5" failed="$6" total="$7"
  shift 7
  local done_count=$((executed + reused)) note=""
  ((reused > 0)) && note="（再利用${reused}）"
  if ((failed > 0)); then
    printf '全体レビュー（%s）: 失敗したバッチがあり、実行中の%s本の完了を待っています（%s・%s・%s・完了%s/%s%s・全%sファイル）' \
      "$mode" "$#" "$ag" "$model" "$(batch_running_label "$@")" "$done_count" "$batch_count" "$note" "$total"
  else
    printf '全体レビュー（%s）を実行中です（%s・%s・%s・完了%s/%s%s・全%sファイル）' \
      "$mode" "$ag" "$model" "$(batch_running_label "$@")" "$done_count" "$batch_count" "$note" "$total"
  fi
}

# run_batch_job <バッチ番号> <作業ディレクトリ>: 1バッチを確認し、結果を`r<N>.json`へ保存する（#4769）。
# 並列に起動されるため、親の状態（変数・`finish`・共通の出力ファイル）には触れない。成否は作業ディレクトリの
# `rc`（0＝保存済み）と、失敗時の`message`・`diag`へ書き、報告は親がまとめて行う
run_batch_job() {
  local idx="$1" jd="$2" result_file="$batch_dir/r${idx}.json" rc=0 cause excerpt
  # どこで終わっても`rc`を残す（親は`rc`の有無で終了を判定する。#4785）
  trap '[[ -e "$jd/rc" ]] || printf 1 >"$jd/rc"' EXIT
  local prompt="$jd/prompt" out="$jd/out" log="$jd/log"
  find "$part_dir" -maxdepth 1 -type f -exec cp {} "$jd/" \;
  batch_coverage_text "$idx" >"$jd/coverage"
  cp "$batch_dir/b${idx}.diff" "$jd/diff"
  if ! build_prompt "$prompt" "$jd"; then
    printf 'レビュー用のプロンプトを準備できませんでした（バッチ%s/%s・AI CLIは起動していません）' "$idx" "$batch_count" >"$jd/message"
    diag_payload unknown "" "$ERR_FILE" prepare >"$jd/diag"
    printf '1' >"$jd/rc"
    return 0
  fi
  run_agent "$prompt" "$out" "$log" || rc=$?
  local retried=0 used_turns="$MAX_TURNS"
  if ((rc != 0)) && [[ "$agent" == "claude" && "$(diag_ai_cause "$rc" "$log" "$out")" == turn_limit ]] && [[ "$RETRY_MAX_TURNS" =~ ^[1-9][0-9]*$ ]]; then
    # ターン数の上限で止まったバッチだけを、上限（ターン数・時間）を上げて1回だけやり直す（#4785）。
    # claude CLIの`-p`出力には実際に使ったターン数が出ないため、やり直したことと適用した上限だけを残す
    echo "バッチ${idx}がターン数の上限 ${MAX_TURNS} に達したため、上限 ${RETRY_MAX_TURNS}・${RETRY_TIMEOUT_SECONDS}秒でやり直します" >&2
    retried=1
    used_turns="$RETRY_MAX_TURNS"
    rc=0
    run_agent "$prompt" "$out" "$log" "$RETRY_TIMEOUT_SECONDS" "$RETRY_MAX_TURNS" || rc=$?
  fi
  if ((rc != 0)); then
    cause="$(diag_ai_cause "$rc" "$log" "$out")"
    excerpt="$log"
    [[ -s "$log" ]] || excerpt="$out"
    printf '全体レビューを完走できませんでした（バッチ%s/%s・終了コード %s%s）' "$idx" "$batch_count" "$rc" \
      "$([[ "$cause" == turn_limit ]] && printf '・ターン数の上限 %s に到達%s' "$used_turns" "$([[ $retried == 1 ]] && printf '（上限を上げてやり直しても同じ）')")" >"$jd/message"
    diag_payload "$cause" "$rc" "$excerpt" review >"$jd/diag"
    if [[ "$cause" == turn_limit ]]; then
      local diag_tmp
      diag_tmp="$(jq -c --argjson retried "$([[ $retried == 1 ]] && echo true || echo false)" --argjson turns "$used_turns" \
        '.diagnostic += {turnLimitRetried: $retried, maxTurns: $turns}' "$jd/diag" 2>/dev/null || true)"
      [[ -n "$diag_tmp" ]] && printf '%s' "$diag_tmp" >"$jd/diag"
    fi
    printf '%s' "$rc" >"$jd/rc"
    return 0
  fi
  if ! extract_result_json "$out" >"$result_file.tmp" || [[ ! -s "$result_file.tmp" ]]; then
    rm -f "$result_file.tmp"
    printf '全体レビューの結果（バッチ%s/%s）をJSONとして読めませんでした' "$idx" "$batch_count" >"$jd/message"
    diag_payload parse_failed "" "$out" finalize >"$jd/diag"
    printf '1' >"$jd/rc"
    return 0
  fi
  # 指紋を先に書く（結果だけが残り指紋の無い状態は、証跡に依存する結果なら再評価に倒れる）
  printf '%s' "$evidence_fp" >"${result_file%.json}.fp"
  printf '%s' "$host_fp" >"${result_file%.json}.hfp"
  mv "$result_file.tmp" "$result_file"
  printf '0' >"$jd/rc"
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
  local batch_dir="" batch_count=0 input_files=0 codex_command="" evidence_fp="" host_fp="" reuse_note=""

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

  # AIのネットワーク権限を増やさず、候補が参照する固定タグの共有コードを先に用意する（#4690）。
  local dependency_dir
  dependency_dir="$(mktemp -d "$WORKTREE/.release-review-dependencies.XXXXXX")"
  python3 "$SCRIPT_DIR/release-review-dependencies.py" "$WORKTREE" "$SCRIPT_DIR/.." "$dependency_dir" >"$dependency_dir/prompt"
  # 別repoの連携先（Issue/PR）の実装・運用証跡も、利用者の送付なしに固定SHAで取得する（#4975）。失敗してもレビューは止めない
  local integration_dir
  integration_dir="$(mktemp -d "$WORKTREE/.release-review-integrations.XXXXXX")"
  python3 "$SCRIPT_DIR/release-review-integrations.py" "$WORKTREE" "$full_name" "$base_sha" "$head_sha" "$integration_dir" \
    >"$integration_dir/prompt" 2>/dev/null || {
    # 空資料にして正常扱いにしない。取得不能として資料と指紋へ残す
    printf '\n## 連携先の実装・運用証跡（ランナーが固定SHAで自動取得）\n\n連携先の自動取得スクリプトが異常終了しました。連携先の証跡は取得不能として扱い、関連する未確認を合格にも対象外にもしません。\n' >"$integration_dir/prompt"
    printf 'script-failed' >"$integration_dir/fingerprint"
  }

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
  batch_dir="$WORK_ROOT/${repo}-${pr_number}-${base_sha:0:12}-${head_sha:0:12}-${DIFF_BUDGET_BYTES}.batches"
  mkdir -p "$batch_dir"
  touch "$batch_dir"
  prune_batch_dirs
  plan_batches
  # 保存済みの結果は、証跡が更新されていれば証跡に依存するものだけ再評価する（#4632）。
  # 同じSHAでも、前回が統合検証の実行中に作った「未確認」を新しい証跡の下で使い続けない
  evidence_fp="$(evidence_fingerprint "$full_name" "$pr_number" "$base_sha" "$head_sha")"
  if [[ -n "$evidence_fp" ]]; then
    evidence_fp="${evidence_fp}:shared-$(cat "$dependency_dir/fingerprint")"
    evidence_fp="${evidence_fp}:integ-$(cat "$integration_dir/fingerprint" 2>/dev/null || true)"
  fi
  INTEGRATION_EVIDENCE_ACTIVE=0
  [[ -s "$integration_dir/fingerprint" ]] && INTEGRATION_EVIDENCE_ACTIVE=1
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
  host_fp="$(runner_host_fingerprint "$full_name" "$head_sha")"
  invalidate_stale_batches "$evidence_fp" "$checklist_version" "$host_fp"
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
  # 統合検証の証跡（#4616）。AIは読み取り専用でテストを実行できないため、同じ対象の結果だけを渡す
  evidence_prompt_text "$full_name" "$pr_number" "$base_sha" "$head_sha" >"$part_dir/evidence"
  runner_host_prompt_text "$full_name" "$head_sha" >>"$part_dir/evidence"
  cat "$dependency_dir/prompt" >>"$part_dir/evidence"
  cat "$integration_dir/prompt" >>"$part_dir/evidence"
  if [[ -n "$checklist_version" ]]; then
    jq -r '.checklistPrompt // ""' <<<"$ctx_json" >"$part_dir/checklist"
    jq -r '.blockingPolicy // ""' <<<"$ctx_json" >"$part_dir/blocking"
  fi
  local ctx_safe="${ctx_json:-}"
  [[ -n "$ctx_safe" ]] || ctx_safe='{}'
  review_context_text "$ctx_safe" "$effective_mode" "$deny_reason" "$fix_files_file" "$fix_diff_file" >"$part_dir/rereview"
  review_decisions_text "$ctx_safe" >>"$part_dir/rereview"
  printf '%s' "${checklist_version:-}" >"$part_dir/version"
  printf '%s' "$effective_mode" >"$part_dir/mode"
  printf '%s' "$(jq -e '.previous != null' <<<"$ctx_safe" >/dev/null 2>&1 && echo yes || echo no)" >"$part_dir/hasprev"
  printf '%s' "$(jq -e '(.decisions // []) | length > 0' <<<"$ctx_safe" >/dev/null 2>&1 && echo yes || echo no)" >"$part_dir/hasdecisions"

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

  # バッチごとに確認する。保存済みの結果（同じbase・head・予算）は再利用して続きから再開する。
  # 確認するバッチは上限（`PARALLEL`）まで同時に起動する（#4769）。起動は番号順なので、実行予算で残るのは後ろのバッチ
  local mode_label executed=0 reused_batches=0 idx result_file rc remaining=0 parallel="$PARALLEL"
  local -a todo=() run_idxs=() run_pids=() failed_idxs=() keep_idxs=() keep_pids=()
  local next=0 k jd changed=1 fail_message="" fail_diag="" done_pid="" known pid
  [[ "$parallel" =~ ^[1-9][0-9]*$ ]] || parallel=3
  mode_label="$([[ "$effective_mode" == "rereview" ]] && echo 再レビュー || echo 全体確認)"
  for ((idx = 1; idx <= batch_count; idx++)); do
    result_file="$batch_dir/r${idx}.json"
    if [[ -s "$result_file" ]] && jq -e 'type == "object"' "$result_file" >/dev/null 2>&1; then
      reused_batches=$((reused_batches + 1))
      continue
    fi
    if ((${#todo[@]} >= MAX_BATCHES_PER_RUN)); then
      remaining=$((remaining + 1))
      continue
    fi
    todo+=("$idx")
  done
  while ((next < ${#todo[@]} && ${#failed_idxs[@]} == 0)) || ((${#run_idxs[@]} > 0)); do
    # 空きがあれば起動する。1本でも失敗したら新しいバッチは起動しない（実行中のものは完了を待って保存する）
    while ((next < ${#todo[@]} && ${#failed_idxs[@]} == 0 && ${#run_idxs[@]} < parallel)); do
      idx="${todo[next]}"
      next=$((next + 1))
      jd="$part_dir/b${idx}"
      rm -rf "$jd"
      mkdir -p "$jd"
      run_batch_job "$idx" "$jd" </dev/null &
      run_idxs+=("$idx")
      run_pids+=("$!")
      BATCH_PIDS=("${run_pids[@]}")
      changed=1
    done
    if ((changed == 1)); then
      RUNNING_MESSAGE="$(batch_progress_message "$mode_label" "$agent" "${claude_model:-$codex_model}" "$executed" "$reused_batches" "${#failed_idxs[@]}" "$total_files" "${run_idxs[@]}")${reuse_note}"
      release_progress_set review 2 "$RUNNING_MESSAGE" "" "$total_files"
      review_report running "$RUNNING_MESSAGE"
      changed=0
    fi
    keep_idxs=()
    keep_pids=()
    done_pid=""
    # 終了の判定は、各バッチが最後に書く`rc`ファイル（想定外の終了でもEXITトラップが書く）を先に見る。
    # 終わっているものが無いときだけ待つ。bash 5.1以上は`wait -n -p`が返す終了したジョブのPIDを使うので、
    # `kill -0`でPIDを見直すときのPID再利用の影響を受けない（#4785）。複数が同時に終わると`wait -n`は
    # 取りこぼすことがあるため、先に`rc`を見てから待つ
    finished_any=0
    for ((k = 0; k < ${#run_pids[@]}; k++)); do
      [[ -e "$part_dir/b${run_idxs[k]}/rc" ]] && finished_any=1
    done
    if ((finished_any == 0)); then
      if ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1))); then
        # heartbeatも同じシェルの子ジョブなので、バッチ以外のPIDが返ったら無視して待ち直す（成否は`$jd/rc`で判定する）
        wait -n -p done_pid 2>/dev/null || true
        if [[ -n "$done_pid" ]]; then
          known=0
          for pid in "${run_pids[@]}"; do [[ "$pid" == "$done_pid" ]] && known=1; done
          ((known == 1)) || continue
        fi
      else
        sleep 0.5
      fi
    fi
    for ((k = 0; k < ${#run_pids[@]}; k++)); do
      if [[ -e "$part_dir/b${run_idxs[k]}/rc" || "${run_pids[k]}" == "$done_pid" ]]; then
        :
      elif ((finished_any == 0)) && ! ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1))) && ! kill -0 "${run_pids[k]}" 2>/dev/null; then
        :
      else
        keep_idxs+=("${run_idxs[k]}")
        keep_pids+=("${run_pids[k]}")
        continue
      fi
      wait "${run_pids[k]}" 2>/dev/null || true
      idx="${run_idxs[k]}"
      jd="$part_dir/b${idx}"
      changed=1
      if [[ "$(cat "$jd/rc" 2>/dev/null || true)" == "0" ]]; then
        executed=$((executed + 1))
        continue
      fi
      failed_idxs+=("$idx")
    done
    run_idxs=("${keep_idxs[@]}")
    run_pids=("${keep_pids[@]}")
    BATCH_PIDS=("${run_pids[@]}")
  done
  if ((${#failed_idxs[@]} > 0)); then
    # 報告する失敗は番号の最も小さいバッチ。他のバッチの成否は文面に添える
    idx="$(printf '%s\n' "${failed_idxs[@]}" | sort -n | head -n 1)"
    jd="$part_dir/b${idx}"
    fail_message="$(cat "$jd/message" 2>/dev/null || true)"
    [[ -n "$fail_message" ]] || fail_message="全体レビューを完走できませんでした（バッチ${idx}/${batch_count}が異常終了しました）"
    fail_diag="$(cat "$jd/diag" 2>/dev/null || true)"
    [[ -n "$fail_diag" ]] || fail_diag="$(diag_payload unknown "" "$ERR_FILE" review)"
    ((${#failed_idxs[@]} > 1)) && fail_message+="（ほか$((${#failed_idxs[@]} - 1))本も失敗）"
    finish failed "${fail_message}。完了したバッチ（今回${executed}本・再利用${reused_batches}本）は保存済みで、再実行すると失敗したバッチから続けて確認します" "$fail_diag"
    return 0
  fi

  # ファイル別の実績の取りこぼし（報告なし・根拠が空）を、そのファイルだけを対象に1回だけ聞き直す（#4768）。
  # 補完に失敗しても全体レビューは止めない（残ったファイルは未確認として報告する）。バッチをやり直したら補完もやり直す
  local sup_file="$batch_dir/rsup.json"
  ((executed > 0)) && rm -f "$sup_file" "${sup_file%.json}.fp" "${sup_file%.json}.hfp" "$batch_dir/rsup.asked"
  if ((remaining == 0)) && [[ ! -s "$sup_file" ]]; then
    missing_file_pairs
    [[ -s "$batch_dir/sup.pairs" ]] && plan_supplement
    if [[ -s "$batch_dir/sup.pairs" && -s "$batch_dir/sup.files" ]]; then
      RUNNING_MESSAGE="全体レビュー（${mode_label}）を実行中です（${agent}・${claude_model:-$codex_model}・確認実績の補完 $(wc -l <"$batch_dir/sup.files" | tr -d ' ')ファイル・全${total_files}ファイル）${reuse_note}"
      release_progress_set review 2 "$RUNNING_MESSAGE" "" "$total_files"
      review_report running "$RUNNING_MESSAGE"
      supplement_coverage_text >"$part_dir/coverage"
      cp "$batch_dir/sup.diff" "$part_dir/diff"
      rc=0
      if build_prompt "$prompt_file"; then
        rm -f "$output_file" "$log_file"
        run_agent "$prompt_file" "$output_file" "$log_file" "$SUPPLEMENT_TIMEOUT_SECONDS" || rc=$?
      else
        rc=1
      fi
      if ((rc == 0)) && extract_result_json "$output_file" >"$sup_file.tmp" && [[ -s "$sup_file.tmp" ]]; then
        mv "$sup_file.tmp" "$sup_file"
        cp "$batch_dir/sup.files" "$batch_dir/rsup.asked"
        printf '%s' "$evidence_fp" >"${sup_file%.json}.fp"
        printf '%s' "$host_fp" >"${sup_file%.json}.hfp"
      else
        rm -f "$sup_file.tmp"
        echo "確認実績の補完を完了できませんでした（終了コード ${rc}）。取りこぼしたファイルは未確認として報告します" >&2
      fi
    fi
  fi

  # 全バッチが済んだら、バッチをまたぐ相互作用を別に確認する（バッチごとの合格の単純集計で済ませない）
  local need_integration=0 int_file="$batch_dir/rint.json" int_reused=false
  ((batch_count > 1)) && need_integration=1
  # バッチを1つでも今回確認したら、相互作用の確認もやり直す（保存済みの相互作用は古いバッチ結果に基づく）
  ((executed > 0)) && rm -f "$int_file" "${int_file%.json}.fp" "${int_file%.json}.hfp"
  if ((need_integration == 1)) && [[ -s "$int_file" ]] && jq -e 'type == "object"' "$int_file" >/dev/null 2>&1; then
    int_reused=true
  fi
  if ((need_integration == 1 && remaining == 0)) && ! { [[ -s "$int_file" ]] && jq -e 'type == "object"' "$int_file" >/dev/null 2>&1; }; then
    RUNNING_MESSAGE="全体レビュー（${mode_label}）を実行中です（${agent}・${claude_model:-$codex_model}・バッチ間の相互作用を確認・全${total_files}ファイル）${reuse_note}"
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
        "$(diag_payload "$(diag_ai_cause "$rc" "$log_file" "$output_file")" "$rc" "$([[ -s "$log_file" ]] && echo "$log_file" || echo "$output_file")" review)"
      return 0
    fi
    if ! extract_result_json "$output_file" >"$int_file.tmp" || [[ ! -s "$int_file.tmp" ]]; then
      rm -f "$int_file.tmp"
      finish failed "全体レビューの結果（相互作用の確認）をJSONとして読めませんでした" \
        "$(diag_payload parse_failed "" "$output_file" finalize)"
      return 0
    fi
    mv "$int_file.tmp" "$int_file"
    printf '%s' "$evidence_fp" >"${int_file%.json}.fp"
    printf '%s' "$host_fp" >"${int_file%.json}.hfp"
  fi

  release_progress_set finalize 3 "全体レビューの結果を整理しています" "" "$total_files"
  review_report running ""
  # 確認できたファイル数は、AIが根拠つきで報告したファイル別の実績から数える（サーバーが再検証する）。
  # 入力へ載せた数は`inputFiles`として別に報告し、確認の実績とは混ぜない
  local fix_files_json added_json merged_json
  fix_files_json="$(jq -Rsc 'split("\n") | map(select(. != "")) | .[0:300]' <"$fix_files_file" 2>/dev/null || printf '[]')"
  added_json="$(printf '%s\n' "${added_prs[@]:-}" | jq -Rsc 'split("\n") | map(select(. != "") | tonumber)' 2>/dev/null || printf '[]')"
  merged_json="$(merge_batch_results "$remaining" "$reused_batches" "$executed" "$int_reused")" ||
    { finish failed "全体レビューの結果を整形できませんでした" "$(diag_payload parse_failed "" "" finalize)"; return 0; }
  ai_json="$(jq -c --argjson total "$total_files" \
    --argjson fixFiles "$fix_files_json" --argjson fixCount "$fix_diff_count" --argjson added "$added_json" \
    --arg deny "$deny_reason" \
    '. + {totalFiles: $total, fixDiffFiles: $fixFiles, fixDiffFileCount: $fixCount, addedPullRequests: $added}
      + (if $deny == "" then {} else {fullReviewReason: $deny} end)' <<<"$merged_json")" ||
    { finish failed "全体レビューの結果を整形できませんでした" "$(diag_payload parse_failed "" "" finalize)"; return 0; }
  rm -rf "$part_dir"
  # 保存は完走後も残す（#4767）。同じ対象の再評価・再実行が、確認済みのバッチを再利用できるようにする。
  # 掃除は次の起動の`prune_batch_dirs`（期限・件数）が行う
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
