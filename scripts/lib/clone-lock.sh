#!/usr/bin/env bash
# ローカルクローンを変更する操作（fetch・worktree prune/add/remove）を、クローン単位のflockで直列化する（#5349）。
# 統合検証（run-release-verify.sh）と全体レビュー（run-release-review.sh）は、作業ディレクトリは別でも
# 同じクローンへ並行して操作するため、衝突して一過性の失敗（target_missing）になりうる。
# ロックが取れない・flockが無いときは直列化せずに実行する（取れないことで検証・レビューを止めない）。

# clone_lock_run <クローンのパス> <コマンド...>: ロックを取って実行し、コマンドの終了コードを返す
clone_lock_run() {
  local clone="$1" lockfile common
  shift
  common="$(git -C "$clone" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ -n "$common" ]] || { "$@"; return; }
  [[ "$common" = /* ]] || common="$clone/$common"
  lockfile="$common/issue-deck-clone.lock"
  if ! command -v flock >/dev/null 2>&1; then
    "$@"
    return
  fi
  (
    flock -w "${CLONE_LOCK_TIMEOUT_SECONDS:-120}" 9 || echo "warning: クローンのロックを取得できませんでした。直列化せずに続行します" >&2
    "$@"
  ) 9>"$lockfile"
}

# git_retry <試行回数> <コマンド...>: 失敗したら間隔を空けて再試行する。stderrは呼び出し側のリダイレクトに任せる
git_retry() {
  local tries="$1" i rc=0
  shift
  for ((i = 1; i <= tries; i++)); do
    "$@" && return 0
    rc=$?
    ((i < tries)) && sleep "${GIT_RETRY_SLEEP_SECONDS:-2}"
  done
  return "$rc"
}
