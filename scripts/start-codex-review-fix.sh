#!/usr/bin/env bash
# REVIEW_FIX専用。Codexは購読認証でファイル修正のみ行い、検証・commit・pushはこのスクリプトが管理する。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
source "$SCRIPT_DIR/lib/agent-cli.sh"
source "$SCRIPT_DIR/lib/review-usage.sh"
source "$SCRIPT_DIR/lib/pr-review-report.sh"
[[ $# == 6 ]] || { echo 'Usage: start-codex-review-fix.sh owner repo issue PR headSHA jobID' >&2; exit 1; }
owner="$1" repo="$2" issue="$3" pr="$4" sha="$5" JOB_ID="$6"
[[ "$owner/$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$issue" =~ ^[1-9][0-9]*$ && "$pr" =~ ^[1-9][0-9]*$ && "$sha" =~ ^[a-f0-9]{40,64}$ ]] || exit 1
full_name="$owner/$repo"
TMUX_SESSION_NAME="${repo}-review-fix-${issue}"
APP_BASE_URL="$(_review_usage_env_value APP_BASE_URL)"
DISPATCH_SECRET="$(_review_usage_env_value DISPATCH_SECRET)"
host_name="$(_review_usage_env_value DISPATCH_HOST_NAME)"
[[ -n "$host_name" ]] || host_name="$(hostname -s)"
workdir='' local_path='' output='' promptdir='' finished=0
finish() {
  local code=$?
  [[ -z "$output" ]] || rm -f "$output"
  [[ -z "$promptdir" ]] || rm -rf "$promptdir"
  pr_review_heartbeat_stop
  if [[ "$finished" != 1 ]]; then
    pr_review_report "$JOB_ID" failed "Codexのレビュー修正が停止しました（終了コード $code）。サブPCのログを確認してください。"
  fi
  [[ -z "$workdir" || -z "$local_path" ]] || git -C "$local_path" worktree remove --force "$workdir" >/dev/null 2>&1 || true
}
trap finish EXIT
validate() {
  [[ -n "$APP_BASE_URL" && -n "$DISPATCH_SECRET" ]] || return 1
  local payload
  payload="$(jq -nc --arg jobId "$JOB_ID" --arg host "$host_name" '{action:"validate",jobId:$jobId,host:$host}')"
  local response
  response="$(printf 'Authorization: Bearer %s\n' "$DISPATCH_SECRET" | curl -sS --max-time 30 -X POST -H @- -H 'Content-Type: application/json' --data-binary "$payload" "${APP_BASE_URL%/}/api/dispatch/review-fix")"
  if ! jq -e '.review | type == "string"' <<<"$response" >/dev/null; then
    jq -r '.error // "修正対象の検証に失敗しました"' <<<"$response" >&2
    return 1
  fi
  printf '%s' "$response"
}
pr_review_report "$JOB_ID" running 'Codexでレビュー指摘を修正中です'
PR_REVIEW_RUNNING_MESSAGE='Codexでレビュー指摘を修正中です'
pr_review_heartbeat_start "$JOB_ID"
review="$(validate | jq -er '.review')"
local_path="$(local_repo_resolve_path "$full_name")"
# 同じIssueの既存worktree/セッションへは入らない。ロックは同じホストでの修正二重起動を防ぐ。
lock_root="${TMPDIR:-/tmp}/issue-deck-review-fix-locks"
mkdir -p "$lock_root"
exec 9>"$lock_root/${owner}-${repo}-${issue}.lock"
flock -n 9 || { echo '同じIssueの修正が実行中です' >&2; exit 1; }
if tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "${repo}-issue-${issue}"; then echo '実装セッションが動いています' >&2; exit 1; fi
git -C "$local_path" fetch --quiet origin "refs/heads/issue-${issue}"
[[ "$(git -C "$local_path" rev-parse FETCH_HEAD)" == "$sha" ]] || exit 1
workdir="$(mktemp -d "${TMPDIR:-/tmp}/issue-deck-review-fix.XXXXXX")"
rmdir "$workdir"
git -C "$local_path" worktree add --detach "$workdir" "$sha" >/dev/null
# 既に導入済みの依存だけを共有する。新規依存やinstallは行わない。
[[ ! -d "$local_path/node_modules" ]] || ln -s "$local_path/node_modules" "$workdir/node_modules"
promptdir="$(mktemp -d "${TMPDIR:-/tmp}/issue-deck-review-fix-prompt.XXXXXX")"
printf '%s\n' "$review" > "$promptdir/review.md"
cat > "$promptdir/prompt.md" <<PROMPT
あなたは $full_name のIssue #$issue / PR #$pr のレビュー指摘を修正します。日本語で応答してください。
CLAUDE.mdとリポジトリの規約を読み、$promptdir/review.mdの指摘だけを修正してください。
人の判断が必要なら変更せず停止してください。依存追加は禁止です。
commit、push、PR/Issue作成、ラベル変更はしないでください。検証とpushは呼出元が行います。
修正できない場合は終了結果に REVIEW_FIX_BLOCKED と明記してください。
PROMPT
codex_command="$(agent_cli_codex_command)"
settings="$(curl -fsS --max-time 10 "${APP_BASE_URL%/}/api/settings/claude-model")"
model="$(jq -r '.workflowCodexModel // "auto"' <<<"$settings")"
effort="$(jq -r '.workflowCodexReasoningEffort // "default"' <<<"$settings")"
args=()
case "$model" in auto) ;; gpt-6-astra|gpt-6-sol|gpt-5.6-terra|gpt-6-luna|gpt-5.5|gpt-5.4) args+=(--model "$model");; *) exit 1;; esac
case "$effort" in default) ;; low|medium|high|xhigh) args+=(-c "model_reasoning_effort=\"$effort\"");; *) exit 1;; esac
output="$(mktemp)"
# 書込みは隔離worktree内のみ。GitHubへの書込みはCodexに任せない。
timeout "${ISSUE_DECK_CODEX_REVIEW_FIX_TIMEOUT_SECONDS:-1800}" "$codex_command" exec --sandbox workspace-write --ephemeral "${args[@]}" --output-last-message "$output" -C "$workdir" - < "$promptdir/prompt.md"
! grep -q 'REVIEW_FIX_BLOCKED' "$output" || exit 1
rm -f "$output"
[[ "$(git -C "$workdir" rev-parse HEAD)" == "$sha" ]] || exit 1
cd "$workdir"
git diff --check
# 実行可能な検証が無いリポジトリを成功扱いしない。
[[ -f package.json ]] || { echo 'package.jsonの検証手順がありません。手動確認が必要です' >&2; exit 1; }
# 検証の定義・依存宣言の変更は自動適用せず、人へ渡す。
if ! git diff --quiet "$sha" -- package.json pnpm-lock.yaml package-lock.json yarn.lock; then
  echo '検証定義または依存宣言の変更を含むため停止しました' >&2
  exit 1
fi
manager=npm
[[ ! -f pnpm-lock.yaml ]] || manager=pnpm
verified=0
for task in lint typecheck test; do
  if jq -e --arg task "$task" '.scripts[$task] | type == "string"' package.json >/dev/null; then
    CI=true timeout 600 "$manager" run "$task"
    verified=1
  fi
done
[[ "$verified" == 1 ]] || { echo 'lint/typecheck/testの検証手順がありません' >&2; exit 1; }
[[ -n "$(git status --porcelain)" ]] || { echo '修正差分がありません' >&2; exit 1; }
[[ "$(validate | jq -er '.review')" == "$review" ]] || { echo 'レビュー内容が更新されたため停止しました' >&2; exit 1; }
# 共有用symlinkをgit addへ渡さない（対象repoの.gitignoreには依存しない）。
[[ ! -L node_modules ]] || rm node_modules
git add -A
git -c user.name='Codex' -c user.email='codex@openai.com' commit -m "レビュー指摘を修正する #${issue}"
# forceもrebaseも行わない。検証後の追いコミットは通常pushが拒否する。
[[ "$(git ls-remote origin "refs/heads/issue-${issue}" | cut -f1)" == "$sha" ]] || exit 1
[[ "$(validate | jq -er '.review')" == "$review" ]] || { echo 'レビュー内容が更新されたため停止しました' >&2; exit 1; }
git push origin "HEAD:refs/heads/issue-${issue}"
[[ "$(git ls-remote origin "refs/heads/issue-${issue}" | cut -f1)" == "$(git rev-parse HEAD)" ]] || exit 1
gh pr comment "$pr" --repo "$full_name" --body "Codexがレビュー指摘を修正し、検証後に同じブランチへpushしました。再レビューを待ちます。<!-- issue-deck-source:claude-review-fix -->"
pr_review_report "$JOB_ID" succeeded 'レビュー指摘の修正と検証・pushが完了しました。再レビューを待ちます'
finished=1
