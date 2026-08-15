#!/usr/bin/env bash
# ポートを掴んだまま残った開発サーバーを、**PIDファイルに依らず**掃く（#1525・#1523の子）。
#
# 使い方:
#   scripts/sweep-orphan-dev-servers.sh                    孤児を掃除する
#   scripts/sweep-orphan-dev-servers.sh --dry-run          判定だけ表示し、何も止めない
#   scripts/sweep-orphan-dev-servers.sh --grace-minutes 30 猶予（分）を指定する（0で無効）
#
# 環境変数:
#   DEV_SERVER_ORPHAN_GRACE_MINUTES   起動からこの分数が経つまで掃除しない（既定30・0で無効）
#
# ## なぜ scripts/reap-dev-servers.sh と別に要るか（多層防御）
#
# あちらの入口は`.dev-servers/issue-<番号>.pid`**だけ**で、次の場合に取りこぼす。
#
#   - PIDファイルが書かれる前・消えた後にプロセスだけが残った（SIGKILL・ホストの強制再起動・
#     `.dev-servers/`を手で消した後）
#   - worktreeごと消えたのに、開いていた開発サーバーだけが残った
#   - pollerが止まっている（あちらは`scripts/subpc-dispatch-poller.sh`の1巡に相乗りしている）
#
# ここは**実際にポートを掴んでいるプロセス**（`ss -tlnp`）から入るため、上のどれにも当たらない。
# 起動経路はsystemd timer（`deploy/subpc/issue-deck-dev-server-sweep.timer`・既定1時間ごと）で、
# pollerとは独立している。**pollerが落ちていても効く**のがこの段の存在意義。
#
# 2026-08-15にサブPCで孤児9本が約5?6GBを占有しOOMに至った（#1523）。開発サーバーは1本あたり
# 0.45〜1.13GiBで、実効RAM 13Giのホストでは数本の取りこぼしがそのまま停止に繋がる。
#
# ## 判定の作法
#
# **これは計器であって役ではない**（docs/multi-agent/gates.md「計器」）。判断はせず、決まった
# 条件に当てはまるプロセスを止めて記録するだけで、LLMも人への問い合わせも挟まない。
#
# **判定できないときは必ず「止めない」側へ倒す。** プロセスグループごと撃つ以上、外したときに
# 巻き込むのは実装セッションそのものになりうる。
#
# ## ポート番号からIssue番号を逆算しない（#1525）
#
# 元の案は「ポート`5XXXX`→Issue番号`XXXX`」だったが、**実際のポートは
# 「リポジトリごとのベース値 + Issue番号」**（scripts/local-repo-ports.conf）で、issue-deckが
# 4000〜5999の2000ぶんを占めるなど帯の幅も一定でない。ポートから逆算すると複数のリポジトリに
# 当てはまりうる（例: 6500はdayspanの#500ともissue-deckの#2500とも読める）。
#
# 代わりに`/proc/<pid>/cwd`を使う。worktreeの置き場は`<repo>-worktrees/issue-<番号>`で
# 統一されている（scripts/start-issue.sh・scripts/generic-start-issue.sh）ため、**cwdだけで
# リポジトリ名とIssue番号の両方が確定する**。対応表を増やさずに済み、帯を割り直しても壊れない。
# ポートは記録と`tailscale serve`の撤去にだけ使う。
#
# この形なので、次のものは**パスが当たらず自動的に対象外**になる。
#
#   - developの常駐開発サーバー（`<置き場>/develop`・#1289）
#   - 横断質問セッション（`<置き場>/.questions/question-<番号>`・#1454）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 止め方・PIDの素性の判定は回収スクリプトと共有する。**止め方を増やさない**（#1223）。
# shellcheck source=scripts/lib/dev-server.sh
source "$SCRIPT_DIR/lib/dev-server.sh"
# 掴んでいたポートの`tailscale serve`（#1265）も一緒に外す。
# shellcheck source=scripts/lib/tailscale-serve.sh
source "$SCRIPT_DIR/lib/tailscale-serve.sh"

GRACE_MINUTES="${DEV_SERVER_ORPHAN_GRACE_MINUTES:-30}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --grace-minutes)
      GRACE_MINUTES="${2:-}"
      shift 2 || true
      ;;
    *)
      echo "Usage: scripts/sweep-orphan-dev-servers.sh [--dry-run] [--grace-minutes <分>]" >&2
      exit 1
      ;;
  esac
done

# 設定は外部（dispatch.env・引数）から来るので、数値であることを確かめてから使う。
# 不正な値で猶予が0秒になり、起動直後（tmuxセッションが立つ前）の開発サーバーを撃つのを防ぐ。
if [[ ! "$GRACE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Error: 猶予の分数は0以上の整数で指定してください: $GRACE_MINUTES" >&2
  exit 1
fi

if [[ "$GRACE_MINUTES" -eq 0 ]]; then
  echo "孤児の定期掃除は無効です（DEV_SERVER_ORPHAN_GRACE_MINUTES=0）。"
  exit 0
fi

GRACE_SECONDS=$((GRACE_MINUTES * 60))

# 実行の記録を`logger`でsyslogにも残す（#1525）。**止めた事実と理由だけを送る。**
# systemd配下ではstdoutもjournaldへ行くが、手で叩いたときは端末にしか残らない。
# 「なぜ開発サーバーが落ちているのか」を後から追えることが、この段の唯一の証拠になる。
sweep_log() {
  local message="$1"
  echo "$message"
  if command -v logger >/dev/null 2>&1; then
    logger -t issue-deck-dev-server-sweep -p user.notice -- "$message" || true
  fi
  return 0
}

if ! command -v ss >/dev/null 2>&1; then
  echo "開発サーバーの定期掃除: \`ss\`が無いため何もしません。"
  exit 0
fi

# tmuxのセッション一覧を1度だけ取る。**取れなければ何もしない。**
#
# `has-session`を1件ずつ叩くと、tmuxサーバーが一時的に応答しない間の失敗が
# 「セッションが無い（＝孤児）」に見え、生きているセッションの開発サーバーを軒並み撃つ。
# 「サーバーが動いていない」だけは**セッションが1つも無いことの確定した表明**なので、
# その場合に限り空の一覧として扱う。
TMUX_SESSIONS=""

collect_tmux_sessions() {
  local out rc=0
  command -v tmux >/dev/null 2>&1 || return 1
  out="$(tmux list-sessions -F '#{session_name}' 2>&1)" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    if [[ "$out" == *"no server running"* ]]; then
      TMUX_SESSIONS=""
      return 0
    fi
    echo "Error: tmuxのセッション一覧を取得できませんでした: $out" >&2
    return 1
  fi
  TMUX_SESSIONS="$out"
  return 0
}

if ! collect_tmux_sessions; then
  sweep_log "開発サーバーの定期掃除: tmuxのセッションを確認できないため何もしません（安全側）。"
  exit 0
fi

session_alive() {
  local name="$1" line
  [[ -n "$TMUX_SESSIONS" ]] || return 1
  while IFS= read -r line; do
    [[ "$line" == "$name" ]] && return 0
  done <<<"$TMUX_SESSIONS"
  return 1
}

CHECKED=0
STOPPED=0
declare -A SEEN_PID=()

# `ss -tlnpH`のLocal Address列（4番目）と、その後ろ全部（プロセス情報）を読む。
#
# **`$NF`だけを見てはいけない。** プロセス名は`users:(("next-server (v1",pid=...`のように
# **空白を含む**ため、awkのフィールドは名前の途中で割れる。5番目以降を連結して`pid=`を拾う。
# プロセス情報が無い行（`tailscale serve`がtailnetアドレスで張っている待ち受けなど）は
# `pid=`を含まないので、ここで落ちる。
while read -r local_addr proc_info; do
  [[ "$proc_info" =~ pid=([0-9]+) ]] || continue
  pid="${BASH_REMATCH[1]}"
  # 同じプロセスがIPv4/IPv6の両方で待ち受けていることがある。1回だけ見る
  [[ -z "${SEEN_PID[$pid]:-}" ]] || continue
  SEEN_PID["$pid"]=1

  port="${local_addr##*:}"
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || continue

  # cwdがIssue専用worktreeでなければ、そもそもこの掃除の対象ではない（判定材料はこれだけ）。
  # **worktreeごと消えている場合も拾う**（`dev_server_cwd_of`が` (deleted)`の印を落とす）
  cwd="$(dev_server_cwd_of "$pid" || true)"
  [[ -n "$cwd" ]] || continue
  leaf="${cwd##*/}"
  worktree_base="${cwd%/*}"
  [[ "$leaf" =~ ^issue-([1-9][0-9]*)$ ]] || continue
  issue_number="${BASH_REMATCH[1]}"
  [[ "${worktree_base##*/}" =~ ^(.+)-worktrees$ ]] || continue
  repo="${BASH_REMATCH[1]}"

  CHECKED=$((CHECKED + 1))

  # 待ち受けが全インターフェースに出ていないか（#1526）。**孤児かどうかとは独立に見る。**
  #
  # 待ち受けの既定は`127.0.0.1`になったが（scripts/dev.sh）、**worktreeは分岐した時点の
  # スクリプトを持ち続ける**ため、#1329より前に作られたworktreeで手で`pnpm dev`を叩くと従来どおり
  # 外へ出る（#1526の時点で、閉じる判定を持たないworktreeが125件中65件あった）。セッション経由の
  # 起動は`run-issue-session.sh`の`ISSUE_DECK_DEV_HOST`で塞がるが、手で起こし直す経路は塞げない。
  # **ここは実際にポートを掴んでいるプロセスから入るので、PIDファイルの有無によらず見つかる。**
  #
  # **止めない。** 掃除の判定材料はtmuxセッションの有無と猶予だけに保つ（画面確認中のものを
  # 誤って撃たない）。**worktreeのログにも書かない**（ログのmtimeは`reap-dev-servers.sh`の
  # アイドル判定の材料で、ここで毎回書くとアイドルでの回収が永久に成立しなくなる）。
  if dev_server_wildcard_listening "$port"; then
    sweep_log "警告: 開発サーバーがポート $port を全インターフェースで待ち受けています（$repo #$issue_number）。tailnet上の他端末から到達できます（#1526）。"
    sweep_log "      $cwd の scripts/dev.sh が古い可能性があります。git -C $cwd merge origin/develop で取り込むか、worktreeを作り直してください。"
  fi

  # 撃つのはプロセスグループ。`set -m`で起動した開発サーバーは`pnpm dev`がリーダーになる
  # （run-issue-session.sh）。リーダーが同じworktreeに居ることまで確かめる
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ ! "$pgid" =~ ^[1-9][0-9]*$ ]] || ! dev_server_pid_matches "$pgid" "$cwd"; then
    echo "  #$issue_number($repo): 情報: ポート $port のPID $pid は素性を確かめられないため触りません。" >&2
    continue
  fi

  # **プロセスグループのリーダーが開発サーバーの起動コマンドであることまで要求する。**
  # cwdだけで撃つと、同じworktreeで動く`claude`本体を巻き込みうる。
  leader_cmd="$(tr '\0' ' ' <"/proc/$pgid/cmdline" 2>/dev/null || true)"
  if [[ ! "$leader_cmd" =~ (^|[[:space:]/])(pnpm|npm|yarn|bun|next)([[:space:]]+run)?[[:space:]]+dev([[:space:]]|$) ]]; then
    echo "  #$issue_number($repo): 情報: ポート $port のプロセスグループ $pgid は開発サーバーではないため触りません。" >&2
    continue
  fi

  session="${repo//[^A-Za-z0-9_-]/-}-issue-$issue_number"
  if session_alive "$session"; then
    continue
  fi

  # 猶予。**tmuxセッションが立つ前の開発サーバーを撃たないための時間。**
  # 起動の順序（開発サーバー → tmuxセッション）が経路によって前後するうえ、`next dev`が
  # ポートをbindするまでにも数秒〜十数秒かかる。ここが唯一の誤爆の防波堤になる
  etimes="$(ps -o etimes= -p "$pgid" 2>/dev/null | tr -d '[:space:]')"
  if [[ ! "$etimes" =~ ^[0-9]+$ ]]; then
    echo "  #$issue_number($repo): 情報: プロセスグループ $pgid の起動からの経過を取れないため触りません。" >&2
    continue
  fi
  if [[ "$etimes" -lt "$GRACE_SECONDS" ]]; then
    echo "  #$issue_number($repo): tmuxセッション「$session」はありませんが、起動から $((etimes / 60))分（猶予 ${GRACE_MINUTES}分）のため見送ります。"
    continue
  fi

  reason="tmuxセッション「$session」が無く、起動から $((etimes / 60))分が経っている（孤児）"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  #$issue_number($repo): [dry-run] $reason のため停止する対象です（プロセスグループ $pgid・ポート $port）"
    continue
  fi

  log_file="$worktree_base/.dev-servers/issue-$issue_number.log"
  dev_server_log_event "$log_file" "定期掃除で開発サーバー（プロセスグループ $pgid・ポート $port）を回収しました: $reason。再び画面確認が必要になったら \`cd $cwd && pnpm dev\` で起こしてください。"

  if dev_server_stop_group "$pgid"; then
    sweep_log "開発サーバーを回収しました: $repo #$issue_number（プロセスグループ $pgid・ポート $port）: $reason"
    STOPPED=$((STOPPED + 1))
  else
    sweep_log "警告: 開発サーバーを停止できませんでした: $repo #$issue_number（プロセスグループ $pgid・ポート $port）"
    dev_server_log_event "$log_file" "定期掃除での停止はSIGKILLでも効きませんでした（プロセスグループ $pgid）。"
    continue
  fi

  # 後始末。PIDファイルは、今止めたプロセスグループを指しているときだけ消す
  pid_file="$worktree_base/.dev-servers/issue-$issue_number.pid"
  if [[ "$(cat "$pid_file" 2>/dev/null || true)" == "$pgid" ]]; then
    rm -f "$pid_file"
  fi

  # 掴んでいたポートの`tailscale serve`（#1265）を外す。外し忘れると繋がらないURLが残るだけでなく、
  # **そのポートが恒久的に使えなくなる**（serveがtailnetアドレスで掴み、`next dev`が
  # `EADDRINUSE`で起動できない。#1403）。**reap-dev-servers.shの2回連続判定は要らない。**
  # あちらは「待ち受けが無い＝孤児か起動途中か」を区別できないが、ここは自分で止めた直後で、
  # そのポートに待ち受けが居ないことが確定している
  tailscale_serve_unpublish "$port"
done < <(ss -tlnpH 2>/dev/null | awk '{ rest = ""; for (i = 5; i <= NF; i++) rest = rest $i; print $4, rest }')

sweep_log "開発サーバーの定期掃除: 確認 $CHECKED 件・停止 $STOPPED 件（猶予 ${GRACE_MINUTES}分）"
