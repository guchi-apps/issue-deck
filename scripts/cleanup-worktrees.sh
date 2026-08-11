#!/usr/bin/env bash
# マージ済みIssueのworktree・ブランチを掃除する（#1100）
#
# 使い方:
#   scripts/cleanup-worktrees.sh [--dry-run] [--yes] [--issue <番号>] [--no-fetch]
#
#   --dry-run       判定結果を表示するだけで削除しない
#   --yes / -y      確認プロンプトを出さずに削除する
#   --issue <番号>  対象を1つのIssueに絞る
#   --no-fetch      origin/develop の最新化（git fetch）を行わない
#
# 次をすべて満たすworktreeだけを削除対象にする。1つでも欠けたら残す。
#   - ブランチ issue-<番号> をheadとするPRがマージ済み
#   - 未コミットの変更が無い
#   - ブランチのコミットがすべて origin/develop に入っている（未pushの作業が無い）
#   - そのIssueのセッション・開発サーバーが動いていない
#   - このスクリプトを実行しているworktreeでない
#
# 削除するのは worktree・ローカルブランチ・そのIssue用の生成物（起動用プロンプト、
# 開発サーバーのログ・PIDファイル）まで。リモートブランチには触れない。
#
# 環境変数:
#   ISSUE_DECK_WORKTREE_BASE  worktreeの置き場所（既定: ~/apps/issue-deck-worktrees）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
PROMPT_DIR="$WORKTREE_BASE/.prompts"
DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"

# shellcheck source=scripts/lib/worktree-status.sh
source "$ROOT/scripts/lib/worktree-status.sh"

usage() {
  echo "Usage: scripts/cleanup-worktrees.sh [--dry-run] [--yes] [--issue <番号>] [--no-fetch]"
}

DRY_RUN=0
ASSUME_YES=0
DO_FETCH=1
TARGET_ISSUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-fetch) DO_FETCH=0 ;;
    --issue) shift; TARGET_ISSUE="${1:-}" ;;
    --issue=*) TARGET_ISSUE="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Error: 不明な引数です: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ -n "$TARGET_ISSUE" && ! "$TARGET_ISSUE" =~ ^[0-9]+$ ]]; then
  echo "Error: --issue は数字で指定してください: $TARGET_ISSUE" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh コマンドが見つかりません。" >&2
  exit 1
fi

if [[ "$DO_FETCH" -eq 1 ]]; then
  echo "origin/develop を最新化しています..."
  git -C "$ROOT" fetch origin develop
fi

# 実行中のカレントディレクトリと、このスクリプトが置かれているチェックアウトは削除しない。
# 自分の足元を消すと git の内部状態も巻き込むため。
CURRENT_DIR="$(pwd -P)"

# 判定結果。表示は「削除対象 → 残す」の順にまとめるため、いったん配列へ貯める。
target_dirs=()
target_numbers=()
target_notes=()
keep_notes=()

while IFS= read -r line; do
  [[ "$line" == worktree\ * ]] || continue
  dir="${line#worktree }"

  # 管理対象は $WORKTREE_BASE/issue-<番号> だけ。本体チェックアウトや手作りのworktreeは触らない。
  case "$dir" in
    "$WORKTREE_BASE"/issue-*) ;;
    *) continue ;;
  esac
  n="${dir#"$WORKTREE_BASE"/issue-}"
  [[ "$n" =~ ^[0-9]+$ ]] || continue
  if [[ -n "$TARGET_ISSUE" && "$n" != "$TARGET_ISSUE" ]]; then
    continue
  fi

  if [[ "$CURRENT_DIR" == "$dir" || "$CURRENT_DIR" == "$dir"/* || "$ROOT" == "$dir" ]]; then
    keep_notes+=("#$n このスクリプトを実行しているworktree")
    continue
  fi

  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    keep_notes+=("#$n gitの作業ツリーとして壊れている（中身を確認して手動で削除する）")
    continue
  fi

  branch="$(git -C "$dir" branch --show-current)"
  if [[ "$branch" != "issue-$n" ]]; then
    keep_notes+=("#$n 別ブランチを開いている（${branch:-デタッチHEAD}）")
    continue
  fi

  if worktree_session_running "$n" "$WORKTREE_BASE"; then
    keep_notes+=("#$n セッションまたは開発サーバーが動いている")
    continue
  fi

  merged_pr="$(worktree_merged_pr "$n")"
  if [[ -z "$merged_pr" ]]; then
    keep_notes+=("#$n マージ済みPRが無い（作業中）")
    continue
  fi

  dirty_count="$(worktree_dirty_count "$dir")"
  if [[ "$dirty_count" -gt 0 ]]; then
    keep_notes+=("#$n PR #$merged_pr はマージ済みだが、未コミットの変更が $dirty_count 件ある")
    continue
  fi

  if ! worktree_branch_in_develop "$ROOT" "issue-$n"; then
    keep_notes+=("#$n PR #$merged_pr はマージ済みだが、origin/develop に入っていないコミットがある")
    continue
  fi

  target_dirs+=("$dir")
  target_numbers+=("$n")
  target_notes+=("PR #$merged_pr マージ済み / $(du -sh "$dir" 2>/dev/null | cut -f1)")
done < <(git -C "$ROOT" worktree list --porcelain)

echo ""
echo "=== 削除対象 (${#target_dirs[@]}件) ==="
if [[ ${#target_dirs[@]} -eq 0 ]]; then
  echo "  (なし)"
else
  for i in "${!target_dirs[@]}"; do
    printf '  #%s  %s\n' "${target_numbers[$i]}" "${target_notes[$i]}"
  done
  # pnpmはnode_modulesの実体をストアへのハードリンクとして持つため、worktreeごとのduは
  # 他のworktreeと共有している分まで数える。実際に解放されるのはこの合計よりかなり小さい。
  echo "  ※サイズはpnpmストアとのハードリンク共有分を含むため、実際に解放される容量はこれより小さい"
fi

echo ""
echo "=== 残すworktree (${#keep_notes[@]}件) ==="
if [[ ${#keep_notes[@]} -eq 0 ]]; then
  echo "  (なし)"
else
  for note in "${keep_notes[@]}"; do
    echo "  $note"
  done
fi
echo ""

if [[ ${#target_dirs[@]} -eq 0 ]]; then
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "--dry-run のため削除しません。"
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "非対話実行のため削除しません。削除する場合は --yes を付けて実行してください。"
    exit 0
  fi
  read -r -p "上記 ${#target_dirs[@]} 件のworktree・ブランチを削除しますか？ [y/N]: " answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "中止しました。"; exit 0 ;;
  esac
fi

failed=0
for i in "${!target_dirs[@]}"; do
  dir="${target_dirs[$i]}"
  n="${target_numbers[$i]}"
  echo "#$n: worktreeを削除しています（$dir）..."
  if ! git -C "$ROOT" worktree remove "$dir"; then
    echo "警告: #$n のworktree削除に失敗しました。ブランチはそのまま残します。" >&2
    failed=$((failed + 1))
    continue
  fi
  # コミットがすべて origin/develop に入っていることを確認済みなので -D でよい。-d は
  # 「現在のHEADにマージ済みか」を見るため、本体チェックアウトが別のIssueブランチを
  # 開いていると消せない。
  if ! git -C "$ROOT" branch -D "issue-$n" >/dev/null; then
    echo "警告: #$n のブランチ削除に失敗しました。" >&2
    failed=$((failed + 1))
  fi
  rm -f "$PROMPT_DIR/issue-$n.md" "$DEV_SERVER_DIR/issue-$n.log" "$DEV_SERVER_DIR/issue-$n.pid"
done

git -C "$ROOT" worktree prune

if [[ "$failed" -gt 0 ]]; then
  echo "$failed 件の削除に失敗しました。" >&2
  exit 1
fi

echo "削除が完了しました。"
