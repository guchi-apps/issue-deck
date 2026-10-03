#!/usr/bin/env bash
# ChatGPTサブスクリプションで認証済みのCodex CLIを、develop向けPRの差分レビューに使う。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/agent-cli.sh
source "$SCRIPT_DIR/lib/agent-cli.sh"

REQUEST_PREFIX='issue-deck-codex-review-request sha='
VERDICT_PREFIX='issue-deck-codex-review-verdict:'
SOURCE_MARKER='<!-- issue-deck-source:codex-review-develop -->'
TIMEOUT_SECONDS="${ISSUE_DECK_CODEX_PR_REVIEW_TIMEOUT_SECONDS:-1800}"
WORK_ROOT="${ISSUE_DECK_CODEX_PR_REVIEW_ROOT:-${TMPDIR:-/tmp}/issue-deck-codex-pr-reviews}"

usage() {
  echo "Usage: scripts/start-codex-pr-review.sh --sweep <owner> <repo>" >&2
  echo "       scripts/start-codex-pr-review.sh --run <owner> <repo> <PR番号> <base SHA> <head SHA>" >&2
}

marker_for() {
  printf '<!-- %s%s -->' "$1" "$2"
}

session_name_for() {
  local repo="$1" pr_number="$2" head_sha="$3"
  printf '%s' "${repo//[^A-Za-z0-9_-]/-}-codex-pr-review-${pr_number}-${head_sha:0:12}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: $1 コマンドが見つかりません。" >&2
    exit 1
  }
}

cleanup_review_worktree() {
  git -C "$1" worktree remove --force "$2" >/dev/null 2>&1 || rm -rf "$2"
}

run_review() {
  local owner="$1" repo="$2" pr_number="$3" base_sha="$4" head_sha="$5"
  local full_name="$owner/$repo" local_path workdir prompt_file output_file log_file
  local verdict_pattern codex_command cleanup_command

  require_command gh
  require_command git
  require_command timeout
  codex_command="$(agent_cli_codex_command)"
  require_command "$codex_command"
  [[ -f "$SCRIPT_DIR/prompts/codex-pr-review-agent.md" ]] || {
    echo "Error: Codex PRレビュー用プロンプトがありません。" >&2
    exit 1
  }
  local_path="$(local_repo_resolve_path "$full_name")"
  mkdir -p "$WORK_ROOT"
  workdir="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}"
  prompt_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.md"
  output_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.out"
  log_file="$WORK_ROOT/${repo}-${pr_number}-${head_sha:0:12}.log"
  verdict_pattern="${VERDICT_PREFIX}(lgtm|needs-check|changes-requested) sha=${head_sha}"

  # EXITトラップはrun_review終了後に動くため、local変数の値をここで固定する。
  printf -v cleanup_command 'cleanup_review_worktree %q %q' "$local_path" "$workdir"
  trap "$cleanup_command" EXIT

  rm -rf "$workdir"
  # SHAそのもののfetchを許さないホストもあるため、GitHubが公開しているPR refとdevelopを取る。
  # 取得後にhead SHAをworktreeへ指定することで、要求時点と異なる追いコミットは読まない。
  git -C "$local_path" fetch --quiet origin develop "refs/pull/${pr_number}/head"
  git -C "$local_path" worktree add --detach "$workdir" "$head_sha" >/dev/null
  sed \
    -e "s|{{REPOSITORY}}|$full_name|g" \
    -e "s|{{PR_NUMBER}}|$pr_number|g" \
    -e "s|{{BASE_SHA}}|$base_sha|g" \
    -e "s|{{HEAD_SHA}}|$head_sha|g" \
    "$SCRIPT_DIR/prompts/codex-pr-review-agent.md" >"$prompt_file"

  if ! timeout "$TIMEOUT_SECONDS" "$codex_command" exec --sandbox read-only --ephemeral \
    --output-last-message "$output_file" -C "$workdir" <"$prompt_file" >"$log_file" 2>&1; then
    : >"$output_file"
  fi
  if ! grep -qE "$verdict_pattern" "$output_file" 2>/dev/null; then
    cat >"$output_file" <<EOF
⚠️ Codexによるレビューを完了できなかったか、有効な判定を取得できませんでした。サブPCの実行ログを確認してください。

<!-- issue-deck-codex-review-verdict:failed sha=$head_sha -->
$SOURCE_MARKER
EOF
  else
    printf '\n%s\n' "$SOURCE_MARKER" >>"$output_file"
  fi
  gh pr comment "$pr_number" --repo "$full_name" --body-file "$output_file"
}

sweep() {
  local owner="$1" repo="$2"
  local full_name="$owner/$repo" local_path rows
  local pr_number base_sha head_sha comments request_marker verdict_pattern session_name

  require_command gh
  require_command tmux
  require_command flock
  mkdir -p "$WORK_ROOT"
  # pollerは短い間隔で巡回するため、同じリポジトリを二重に走査しない。
  exec 9>"$WORK_ROOT/${repo}-sweep.lock"
  flock -n 9 || return 0
  local_path="$(local_repo_resolve_path "$full_name" 2>/dev/null || true)"
  [[ -n "$local_path" && -d "$local_path" ]] || return 0
  rows="$(gh pr list --repo "$full_name" --base develop --state open --json number,baseRefOid,headRefOid --jq '.[] | [.number, .baseRefOid, .headRefOid] | @tsv' 2>/dev/null || true)"
  while IFS=$'\t' read -r pr_number base_sha head_sha; do
    [[ -n "$pr_number" && -n "$base_sha" && -n "$head_sha" ]] || continue
    comments="$(gh pr view "$pr_number" --repo "$full_name" --json comments --jq '.comments[].body' 2>/dev/null || true)"
    request_marker="$(marker_for "$REQUEST_PREFIX" "$head_sha")"
    verdict_pattern="${VERDICT_PREFIX}(lgtm|needs-check|changes-requested|failed) sha=${head_sha}"
    grep -qF "$request_marker" <<<"$comments" || continue
    grep -qE "$verdict_pattern" <<<"$comments" && continue
    session_name="$(session_name_for "$repo" "$pr_number" "$head_sha")"
    tmux has-session -t "=$session_name" 2>/dev/null && continue
    tmux new-session -d -s "$session_name" -c "$local_path" \
      "bash $(printf '%q' "$SCRIPT_DIR/start-codex-pr-review.sh") --run $(printf '%q' "$owner") $(printf '%q' "$repo") $(printf '%q' "$pr_number") $(printf '%q' "$base_sha") $(printf '%q' "$head_sha")"
    tmux set-option -t "$session_name:" -w remain-on-exit failed >/dev/null 2>&1 || true
    echo "Codex PRレビューを起動しました: ${full_name}#${pr_number} (${head_sha:0:12})"
  done <<<"$rows"
}

case "${1:-}" in
  --sweep)
    [[ $# -eq 3 ]] || { usage; exit 2; }
    sweep "$2" "$3"
    ;;
  --run)
    [[ $# -eq 6 ]] || { usage; exit 2; }
    run_review "$2" "$3" "$4" "$5" "$6"
    ;;
  *)
    usage
    exit 2
    ;;
esac
