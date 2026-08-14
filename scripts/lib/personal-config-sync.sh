#!/usr/bin/env bash
# 個人設定（`~/.claude/CLAUDE.md`・個人skill）と共有知識（`~/apps/_docs`）が、メインPCと
# サブPCのあいだで取り残されていないかを、セッションを起こす前に警告する（#1190）。
#
# scripts/start-issue.sh と scripts/generic-start-issue.sh の両方から source する。
# このファイル自体は実行せず、source して使う。
#
# ## なぜ起動スクリプトから呼ぶか
#
# 個人設定の実体は `guchi-apps/claude-config` にあり、両機は `~/.claude/` 側をsymlinkにして
# 同じファイルを見る。ただし**片方でpushし忘れる・もう片方でpullし忘れる**のは防げないため、
# 検知する側が要る。実装セッションの起動は、そのルールが実際に読まれる直前であり、かつ
# メインPC・サブPCに共通の唯一の入口なので、ここに置けば見落としが起きにくい。
#
# ## 止めないこと
#
# 判定はあくまで警告で、**起動は止めない**。ネットワークが無い場所・セットアップ前のマシン・
# GitHub Actions（`~/apps/claude-config` が無い）でも、黙って素通りする。同期の遅れは
# 「気づけないこと」が問題であって、実装を止めるほどのものではない。

# 個人設定リポジトリの場所。`~/apps/_docs` を ISSUE_DECK_SHARED_CONTEXT_DIR で
# 上書きできるのと同じ扱い（scripts/run-issue-session.sh）。
PERSONAL_CONFIG_DIR="${ISSUE_DECK_PERSONAL_CONFIG_DIR:-$HOME/apps/claude-config}"

# 同期が遅れていれば警告を出す。戻り値は常に0（呼び出し側を `set -e` で落とさない）。
warn_personal_config_drift() {
  [[ "${ISSUE_DECK_SKIP_CONFIG_SYNC_CHECK:-0}" == "1" ]] && return 0

  local checker="$PERSONAL_CONFIG_DIR/check-sync.sh"
  [[ -x "$checker" ]] || return 0

  # git fetch を含むため、ネットワークが不安定な場所で起動が待たされないよう上限を付ける。
  local runner=()
  command -v timeout >/dev/null 2>&1 && runner=(timeout 15)

  local output
  output="$(${runner[@]+"${runner[@]}"} "$checker" --quiet 2>&1)" || true
  [[ -n "$output" ]] || return 0

  echo "" >&2
  echo "警告: 個人設定・共有知識の同期が取り残されています。" >&2
  echo "$output" >&2
  echo "  （起動は続けます。詳しくは $PERSONAL_CONFIG_DIR/check-sync.sh）" >&2
  echo "" >&2
  return 0
}
