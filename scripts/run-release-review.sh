#!/usr/bin/env bash
# リリースPR（base=main・head=release-main/v*）の差分全体のAIレビュー（#4238・#4212）。
#
# 呼ぶのはサブPCのpoller。DispatchJob（`RELEASE_REVIEW`）を取ったpollerが、tmuxの中で起動する。
# `base...head`の差分全体を読み取り専用のAI（担当はサーバー設定で決まり、`claude`か`codex`）へ渡し、
# 指摘・影響PR・影響ファイルを`/api/dispatch/report`の`releaseReview`として報告する。
#
#   scripts/run-release-review.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA> <ジョブID> <agent> <claudeモデル> <codexモデル>
#
# **差分が大きいときは予算の範囲だけを渡し、確認できなかったファイル数を`totalFiles`・`reviewedFiles`で
# 報告する**（AIの自己申告に任せない）。サーバーは足りなければ「未確認範囲あり」として準備完了にしない。
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
# プロンプトへ入れる差分の上限（バイト）。超えた分のファイルは「未確認」として報告する
DIFF_BUDGET_BYTES="${ISSUE_DECK_RELEASE_REVIEW_DIFF_BUDGET_BYTES:-300000}"

JOB_ID=""
JOB_REPORTED=0
RUNNING_MESSAGE="全体レビューを準備しています"
HEARTBEAT_PID=""
WORKTREE=""
LOCAL_PATH=""
ERR_FILE=""

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

main() {
  local owner="$1" repo="$2" pr_number="$3" base_sha="$4" head_sha="$5"
  JOB_ID="$6"
  local agent="$7" claude_model="${8:-}" codex_model="${9:-}"
  local full_name="$owner/$repo" prompt_file output_file log_file ai_json
  local total_files=0 reviewed_files=0 used_bytes=0 file file_diff size coverage="" diff_text="" prs_text=""
  local -a files=() omitted=() claude_args=() codex_args=() fix_files=() added_prs=() unrelated_prs=()
  local ctx_json="" ctx_mode="initial" effective_mode="initial" deny_reason="" prev_head="" fix_prs_json="[]"
  local checklist_version="" fix_diff_count=0

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

  # 差分の材料。ファイルごとの差分を、予算の範囲で先頭から詰める
  release_progress_set diff 1 "リリースの差分を取得しています"
  review_report running ""
  mapfile -t files < <(git -C "$WORKTREE" diff --name-only "$base_sha...$head_sha")
  total_files="${#files[@]}"
  if ((total_files == 0)); then
    finish succeeded "差分がありません" \
      "$(jq -nc '{state: "passed", summary: "mainとの差分がありません", findings: [], totalFiles: 0, reviewedFiles: 0}')"
    return 0
  fi
  for file in "${files[@]}"; do
    file_diff="$(git -C "$WORKTREE" diff "$base_sha...$head_sha" -- "$file")"
    size="${#file_diff}"
    if ((used_bytes + size > DIFF_BUDGET_BYTES)); then
      omitted+=("$file")
      continue
    fi
    diff_text+="$file_diff"$'\n'
    used_bytes=$((used_bytes + size))
    reviewed_files=$((reviewed_files + 1))
  done
  if ((${#omitted[@]} > 0)); then
    coverage="差分${total_files}ファイルのうち${reviewed_files}ファイルの差分を下に載せました。**次のファイルは差分を載せていません**（必要なら作業ディレクトリで\`git diff ${base_sha}...${head_sha} -- <パス>\`を読んで確認してください）:"$'\n'
    coverage+="$(printf -- '- %s\n' "${omitted[@]:0:100}")"
  else
    coverage="差分${total_files}ファイルすべてを下に載せました。"
  fi
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
  # 前回の実行の出力・ログを今回の結果として読まない（同じSHAの再実行）
  rm -f "$output_file" "$log_file"
  # 差分などの大きな本文は引数・環境変数に載せない（Linuxは1引数128KiBまでで、超えるとexecveが
  # E2BIG＝終了コード126になる。#4316）。ファイルへ書き、Pythonにはパスだけを渡す
  local part_dir="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.parts"
  rm -rf "$part_dir"
  mkdir -p "$part_dir"
  printf '%s' "$coverage" >"$part_dir/coverage"
  printf '%s' "$prs_text" >"$part_dir/prs"
  printf '%s' "$diff_text" >"$part_dir/diff"
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
  if ! python3 - "$SCRIPT_DIR/prompts/release-review-agent.md" "$prompt_file" "$full_name" "$pr_number" "$base_sha" "$head_sha" \
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
  then
    # AI CLIの失敗ではなく、プロンプトの準備段階の失敗として区別して報告する
    rm -rf "$part_dir"
    finish failed "レビュー用のプロンプトを準備できませんでした（AI CLIは起動していません）" \
      "$(diag_payload unknown "" "$ERR_FILE" prepare)"
    return 0
  fi
  rm -rf "$part_dir"

  RUNNING_MESSAGE="全体レビュー（$([[ "$effective_mode" == "rereview" ]] && echo 再レビュー || echo 全体確認)）を実行中です（${agent}・${claude_model:-$codex_model}・差分${reviewed_files}/${total_files}ファイル）"
  release_progress_set review 2 "$RUNNING_MESSAGE" "" "$total_files"
  review_report running "$RUNNING_MESSAGE"
  local exit_code=0
  if [[ "$agent" == "codex" ]]; then
    local codex_command
    codex_command="$(agent_cli_codex_command)"
    command -v "$codex_command" >/dev/null 2>&1 || {
      finish failed "Codex CLIが見つかりません" "$(diag_payload launch_failed "" "" review)"
      return 0
    }
    codex_args=(exec --sandbox read-only --ephemeral -m "$codex_model" --output-last-message "$output_file" -C "$WORKTREE")
    (cd "$WORKTREE" && timeout -k 60 "$TIMEOUT_SECONDS" "$codex_command" "${codex_args[@]}" <"$prompt_file" >"$log_file" 2>&1) || exit_code=$?
  else
    command -v claude >/dev/null 2>&1 || {
      finish failed "claude CLIが見つかりません" "$(diag_payload launch_failed "" "" review)"
      return 0
    }
    claude_args=(-p --model "$claude_model" --allowedTools Read Grep Glob)
    (cd "$WORKTREE" && timeout -k 60 "$TIMEOUT_SECONDS" claude "${claude_args[@]}" <"$prompt_file" >"$output_file" 2>"$log_file") || exit_code=$?
  fi
  if ((exit_code != 0)); then
    local cause
    cause="$(diag_ai_cause "$exit_code" "$log_file")"
    finish failed "全体レビューを完走できませんでした（終了コード ${exit_code}）" \
      "$(diag_payload "$cause" "$exit_code" "$log_file" review)"
    return 0
  fi
  release_progress_set finalize 3 "全体レビューの結果を整理しています" "" "$total_files"
  review_report running ""
  if ! ai_json="$(extract_result_json "$output_file")"; then
    finish failed "全体レビューの結果をJSONとして読めませんでした" \
      "$(diag_payload parse_failed "" "$output_file" finalize)"
    return 0
  fi
  # 確認できたファイル数はこちらで確定した値を載せる（AIの自己申告に任せない）
  # 再レビューの根拠（前回の対象から今回までの修正差分・追加PR・全体確認へ戻した理由）も、実測した値を載せる
  local fix_files_json added_json
  fix_files_json="$(jq -Rsc 'split("\n") | map(select(. != "")) | .[0:300]' <"$fix_files_file" 2>/dev/null || printf '[]')"
  added_json="$(printf '%s\n' "${added_prs[@]:-}" | jq -Rsc 'split("\n") | map(select(. != "") | tonumber)' 2>/dev/null || printf '[]')"
  ai_json="$(jq -c --argjson total "$total_files" --argjson reviewed "$reviewed_files" \
    --argjson fixFiles "$fix_files_json" --argjson fixCount "$fix_diff_count" --argjson added "$added_json" \
    --arg deny "$deny_reason" \
    '. + {totalFiles: $total, reviewedFiles: $reviewed, fixDiffFiles: $fixFiles, fixDiffFileCount: $fixCount, addedPullRequests: $added}
      + (if $deny == "" then {} else {fullReviewReason: $deny} end)' <<<"$ai_json")" ||
    { finish failed "全体レビューの結果を整形できませんでした" "$(diag_payload parse_failed "" "" finalize)"; return 0; }
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
