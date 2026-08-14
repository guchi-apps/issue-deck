#!/usr/bin/env bash
# 実装セッションの開発サーバー（`pnpm dev`）を回収する（#1223）。
#
#   孤児（第0段階）    セッションが畳まれたのに残っている開発サーバーを止める
#   アイドル（第1段階） 作業が終わって誰も見ていない開発サーバーを、**セッションは残したまま**止める
#
# 使い方:
#   scripts/reap-dev-servers.sh                   孤児とアイドルを回収する
#   scripts/reap-dev-servers.sh --dry-run         判定だけ表示し、何も止めない
#   scripts/reap-dev-servers.sh --idle-minutes 0  アイドルの回収を行わない（孤児だけ回収する）
#   scripts/reap-dev-servers.sh --base <dir>      worktreeの置き場を指定する
#
# 環境変数:
#   ISSUE_DECK_WORKTREE_BASE   worktreeの置き場（既定: ~/apps/issue-deck-worktrees）
#   DEV_SERVER_IDLE_MINUTES    アイドルとみなすまでの分数（既定: 60・0で無効）
#
# **対象は`issue-<番号>.pid`だけ**（下のglob）。`develop.pid`（scripts/start-develop-dev.sh・#1289）は
# 意図して常駐させる開発サーバーで、親を持たない（PPID==1）ぶん孤児の条件に必ず当てはまるため、
# ここに含めると起動した直後に止められる。**globを緩めない。**
#
# **これは計器であって役ではない**（docs/multi-agent/gates.md「計器」）。判断はせず、
# 決まった条件に当てはまるプロセスを止めて記録するだけで、LLMも人への問い合わせも挟まない。
# サブPCのpoller（scripts/subpc-dispatch-poller.sh）が1巡ごとに呼ぶため、常駐プロセスは増えない。
#
# **メモリの大半は開発サーバー側にあり、セッション本体は残す価値がある**（#1177の実測で
# `pnpm dev`一式が0.45〜1.13GiB、セッション本体が595MiB）。追加指示で同じセッションを再利用した
# 実例（#1178）があるため、ここではセッションそのものは畳まない。
#
# なぜ孤児が生まれるのか（実測の結論・#1223）:
#   tmuxの`kill-session`でも`run-issue-session.sh`の`trap cleanup`は発火する。しかし破棄済みの
#   ptyへのechoがEIOで失敗し、errexitがcleanupを打ち切っていたため`kill`に到達していなかった。
#   本体（cleanup）は直したが、SIGKILLやホストの再起動ではそもそもtrapを通れない。ここはその保険。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/dev-server.sh
source "$SCRIPT_DIR/lib/dev-server.sh"

WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
IDLE_MINUTES="${DEV_SERVER_IDLE_MINUTES:-60}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --idle-minutes)
      IDLE_MINUTES="${2:-}"
      shift 2 || true
      ;;
    --base)
      WORKTREE_BASE="${2:-}"
      shift 2 || true
      ;;
    *)
      echo "Usage: scripts/reap-dev-servers.sh [--dry-run] [--idle-minutes <分>] [--base <dir>]" >&2
      exit 1
      ;;
  esac
done

# 設定は外部（dispatch.env・引数）から来るので、数値であることを確かめてから使う。
# 不正な値でアイドル判定が0分になり、動いているセッションの開発サーバーを次々止めるのを防ぐ。
if [[ ! "$IDLE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Error: アイドル判定の分数は0以上の整数で指定してください: $IDLE_MINUTES" >&2
  exit 1
fi

DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"
if [[ ! -d "$DEV_SERVER_DIR" ]]; then
  echo "開発サーバーを確認しました: 0 件（$DEV_SERVER_DIR は存在しません）"
  exit 0
fi

NOW="$(date +%s)"
IDLE_SECONDS=$((IDLE_MINUTES * 60))
CHECKED=0
STOPPED=0

# 止める。--dry-run では判定だけ出す。理由は必ずログにも残す（無人実行ではここにしか残らない）。
stop_one() {
  local issue_number="$1" pid="$2" log_file="$3" worktree_dir="$4" reason="$5"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  #$issue_number: [dry-run] $reason のため停止する対象です（PID $pid）"
    return 0
  fi

  dev_server_log_event "$log_file" "開発サーバー（プロセスグループ $pid）を回収しました: $reason。再び画面確認が必要になったら \`cd $worktree_dir && pnpm dev\` で起こしてください。"
  if dev_server_stop_group "$pid"; then
    echo "  #$issue_number: 開発サーバー（PID $pid）を停止しました: $reason"
    STOPPED=$((STOPPED + 1))
  else
    echo "  #$issue_number: 警告: 開発サーバー（PID $pid）を停止できませんでした: $reason" >&2
    dev_server_log_event "$log_file" "開発サーバー（プロセスグループ $pid）はSIGKILLでも停止できませんでした。"
    return 0
  fi
  rm -f "$DEV_SERVER_DIR/issue-$issue_number.pid"
  return 0
}

shopt -s nullglob
for pid_file in "$DEV_SERVER_DIR"/issue-*.pid; do
  file_name="$(basename "$pid_file")"
  issue_number="${file_name#issue-}"
  issue_number="${issue_number%.pid}"
  [[ "$issue_number" =~ ^[1-9][0-9]*$ ]] || continue

  CHECKED=$((CHECKED + 1))
  worktree_dir="$WORKTREE_BASE/issue-$issue_number"
  log_file="$DEV_SERVER_DIR/issue-$issue_number.log"
  pid="$(cat "$pid_file" 2>/dev/null || true)"

  # 既に居ないPIDのファイルは、後始末が途中で終わった名残。掃除するだけで何も止めない。
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  #$issue_number: [dry-run] プロセスが居ないためPIDファイルだけ削除する対象です（PID ${pid:-不明}）"
    else
      rm -f "$pid_file"
    fi
    continue
  fi

  # 生きてはいるが、このworktreeの開発サーバーではない（PIDの再利用など）。
  # **殺さない。** プロセスグループごと撃つ処理なので、確信が持てない相手には触らない。
  if ! dev_server_pid_matches "$pid" "$worktree_dir"; then
    echo "  #$issue_number: 情報: PID $pid はこのworktreeの開発サーバーではないため触りません（PIDファイルは削除します）。" >&2
    [[ "$DRY_RUN" -eq 1 ]] || rm -f "$pid_file"
    continue
  fi

  # 孤児（第0段階）。親の run-issue-session.sh が消えるとinit（PID 1）に引き取られる。
  # **tmuxのセッション名からは判定しない。** リポジトリ名→セッション名の対応表は、Issue番号が
  # リポジトリごとに振られるぶん壊れやすい（#1224）。PPIDはプロセス単位で確定する事実で、
  # 対応表を増やさずに済む。
  ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$ppid" == "1" ]]; then
    stop_one "$issue_number" "$pid" "$log_file" "$worktree_dir" "セッションが終了しても残っていた（孤児）"
    continue
  fi

  # アイドル（第1段階）。**判定材料は開発サーバーのログのmtimeだけ。**
  # `next dev` はリクエストと再コンパイルのたびに書くため、「誰もその画面を見ていない」の
  # 代理になる。**`capture-pane`の内容は読まない**（画面の文字列からの推定は実地で誤判定した
  # 実績がある。docs/multi-agent/gates.md）。
  [[ "$IDLE_SECONDS" -gt 0 ]] || continue
  [[ -f "$log_file" ]] || continue
  log_mtime="$(stat -c %Y "$log_file" 2>/dev/null || echo "")"
  [[ "$log_mtime" =~ ^[0-9]+$ ]] || continue
  idle_for=$((NOW - log_mtime))
  if [[ "$idle_for" -ge "$IDLE_SECONDS" ]]; then
    stop_one "$issue_number" "$pid" "$log_file" "$worktree_dir" \
      "$((idle_for / 60))分アクセスが無くアイドルだった（セッションはそのまま残す）"
  fi
done

echo "開発サーバーを確認しました: $CHECKED 件（停止 $STOPPED 件・アイドル判定 ${IDLE_MINUTES}分）"
