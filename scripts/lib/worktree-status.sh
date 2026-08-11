#!/usr/bin/env bash
# Issue専用worktreeの状態判定（マージ済みか・消してよいか）を共有する（#1100）。
#
# scripts/start-issue.sh（再開時の警告・作り直し）と scripts/cleanup-worktrees.sh（掃除）の
# 両方から source する。「消しても失われないか」の判定は、片方だけを緩めるとその側が単独で
# 事故になるため1か所に置く。
#
# このファイル自体は実行せず、source して使う。

ISSUE_DECK_REPO="${ISSUE_DECK_REPO:-guchi-apps/issue-deck}"

# ブランチ issue-<番号> をheadとするマージ済みPRの番号を出力する（無ければ何も出力しない）。
# gh の失敗（ネットワーク断・未認証）も「マージ済みPRなし」として扱う。判定できないときに
# 削除側へ倒れないようにするため。
worktree_merged_pr() {
  local n="$1"
  gh pr list --repo "$ISSUE_DECK_REPO" --head "issue-$n" --state merged \
    --json number --jq '.[0].number // empty' 2>/dev/null || true
}

# 未コミットの変更の件数を出力する（追跡対象の変更＋未追跡ファイル。`.gitignore`対象の
# node_modules・.env.local は含まれない）。
worktree_dirty_count() {
  local dir="$1"
  git -C "$dir" status --porcelain | wc -l
}

# ブランチのコミットがすべて origin/develop に入っているか（＝worktreeを消しても失われないか）。
# 呼ぶ前に origin/develop を最新化しておくこと。古いままだと「入っていない」と判定され、
# 削除しない側（安全側）に倒れる。
worktree_branch_in_develop() {
  local root="$1" branch="$2"
  git -C "$root" merge-base --is-ancestor "$branch" "origin/develop" 2>/dev/null
}

# そのIssueのセッション（run-issue-session.sh）または開発サーバーが動いているか。
worktree_session_running() {
  local n="$1" worktree_base="$2"
  local pid_file="$worktree_base/.dev-servers/issue-$n.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # `run-issue-session.sh <番号> <ポート> ...` という起動の仕方に一致するものだけを見る。
  # Claude Codeのプロセスはプロンプト全文（Issue本文を含む）をコマンドラインに持つため、
  # 単に "run-issue-session" で引っ掛けるとIssue本文中の言及にまで一致してしまう。
  pgrep -f "run-issue-session\.sh $n " >/dev/null 2>&1
}
