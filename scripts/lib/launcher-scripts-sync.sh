#!/usr/bin/env bash
# 本体リポジトリの作業ツリーにある `scripts/` が `origin/develop` と違っていたら警告する（#1274）。
#
# scripts/start-issue.sh・scripts/generic-start-issue.sh・scripts/run-issue-session.sh の
# いずれからも source する。このファイル自体は実行せず、source して使う。
#
# **`warn_launcher_scripts_stale` の呼び出し自体は start-issue.sh・generic-start-issue.sh と
# run-issue-session.sh の両方に置く（#1426）。** start-issue.sh 側の呼び出しは、tmuxで新しい
# セッションを起動する（`tmux new-session -d`）より前の、呼び出し元プロセス自身の標準出力に
# 出るだけで、そのpaneは呼び出し元とは別のptyとして作られるため引き継がれない。サブPCのpollerが
# 起動する経路（無人）ではその標準出力はjournalctlにしか残らず、tmuxをattachしたユーザーからは
# 見えない。run-issue-session.sh側の呼び出しは実際にそのtmuxのpaneの中で動くため、ここでも
# 同じ警告を出すことで、ユーザーが実際に見る画面に確実に載せる。
#
# ## なぜ必要か
#
# 起動スクリプトもフックも、**worktreeではなく本体リポジトリの作業ツリーから実行される**。
#
#   scripts/start-issue.sh          → 本体の作業ツリー（$ROOT/scripts/）
#   scripts/run-issue-session.sh    → 同上（start-issue.sh が $ROOT/scripts/ を指定して呼ぶ）
#   scripts/session-notify.sh       → 同上（run-issue-session.sh が生成するフック設定の command）
#
# 一方で worktree は `git fetch origin develop` した直後の `origin/develop` から作られる。
# **本体の作業ツリーだけは誰も更新しない**（start-issue.sh は「本体の作業ツリーには一切
# 触れない」ことを約束しているため、fetchはしてもmergeはしない）。
#
# 結果として「developには修正が入っているのに、実際に動いているスクリプトは古いまま」が
# 起こる。#1274ではこれを踏んだ。#1247でセッション通知のリンク書式を直しdevelopへマージ
# したあとも、本体の作業ツリーが数時間前のdevelopのままだったため、実際に飛ぶ通知は
# 古い書式（リンクにならない生URL）のままだった。**スクリプト側には何の兆候も出ない**ので、
# 直したはずの不具合を再度Issueとして起票することになる。
#
# ## 止めないこと・自動でpullしないこと
#
# 判定はあくまで警告で、**起動は止めない**。ネットワークが無い場所・gitのリモートが無い
# 環境でも黙って素通りする。
#
# **ここでpullはしない。** 本体の作業ツリーに触れないのは start-issue.sh の設計上の約束で、
# 未コミットの変更やチェックアウト中のブランチを起動スクリプトが動かしてよいことにすると、
# 「セッションを起こしただけ」の操作が手元の作業を壊しうる。取り込むかどうかは人が決める。

# 比較対象。worktreeの作成元と同じ `origin/develop` を正とする。
LAUNCHER_SYNC_REF="${ISSUE_DECK_LAUNCHER_SYNC_REF:-origin/develop}"

# 本体の `scripts/` が `origin/develop` と違っていれば警告を出す。
# 戻り値は常に0（呼び出し側を `set -e` で落とさない）。
#
# 第1引数は本体リポジトリのパス（start-issue.sh・generic-start-issue.sh の $ROOT、
# run-issue-session.sh では自身の SCRIPT_DIR の親ディレクトリ）。
warn_launcher_scripts_stale() {
  [[ "${ISSUE_DECK_SKIP_SCRIPTS_SYNC_CHECK:-0}" == "1" ]] && return 0

  local root="${1:-}"
  [[ -n "$root" ]] || return 0
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  # 判定の前に fetch する。前回の起動時のfetchに頼ると、警告が必ず1回分遅れて出る。
  # ネットワークが不安定な場所で起動が待たされないよう上限を付ける（失敗しても続ける）。
  if [[ "$LAUNCHER_SYNC_REF" == */* ]]; then
    local runner=()
    command -v timeout >/dev/null 2>&1 && runner=(timeout 15)
    local remote="${LAUNCHER_SYNC_REF%%/*}" branch="${LAUNCHER_SYNC_REF#*/}"
    ${runner[@]+"${runner[@]}"} git -C "$root" fetch "$remote" "$branch" >/dev/null 2>&1 || true
  fi

  # fetchできなかった・そのrefが無い環境では何も言わない。
  git -C "$root" rev-parse --verify --quiet "$LAUNCHER_SYNC_REF" >/dev/null 2>&1 || return 0

  # 作業ツリーと比較する（HEADではなく）。フックが実際に読むのは作業ツリーのファイルなので、
  # コミットされていない手元の変更も「developと違う」として出したほうが実態に合う。
  if git -C "$root" diff --quiet "$LAUNCHER_SYNC_REF" -- scripts/ 2>/dev/null; then
    return 0
  fi

  # 差分のあるファイルは件数が読めないので、先頭数件だけ出して残りは件数で示す。
  # 一覧そのものより「古い」ことに気づけるほうが大事なので、警告を長くしない。
  local all_changed changed total
  all_changed="$(git -C "$root" diff --name-only "$LAUNCHER_SYNC_REF" -- scripts/ 2>/dev/null)"
  total="$(printf '%s\n' "$all_changed" | grep -c . || true)"
  changed="$(printf '%s\n' "$all_changed" | head -5)"

  echo "" >&2
  echo "警告: 本体リポジトリの scripts/ が $LAUNCHER_SYNC_REF と違います（$root）。" >&2
  echo "  起動スクリプトとセッション通知のフックは、worktreeではなく本体の作業ツリーから" >&2
  echo "  実行されます。developに入った修正は pull するまで反映されません（#1274）。" >&2
  if [[ -n "$changed" ]]; then
    local line
    while IFS= read -r line; do
      [[ -n "$line" ]] && echo "    - $line" >&2
    done <<<"$changed"
    if [[ "$total" -gt 5 ]]; then
      echo "    - ほか $((total - 5)) 件" >&2
    fi
  fi
  echo "  取り込む場合: git -C \"$root\" pull" >&2
  echo "  （起動は続けます。手元で意図的に変更している場合はこの警告で構いません）" >&2
  echo "" >&2
  return 0
}
