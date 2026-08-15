#!/usr/bin/env bash
# Issue専用worktreeの開発サーバー（`pnpm dev`）の止め方を共有する（#1223）。
#
# scripts/run-issue-session.sh（セッション終了時・再開時の後始末）と
# scripts/reap-dev-servers.sh（孤児とアイドルの回収）の両方から source する。
# **止め方を2か所に持つと、片方だけが緩んだ時点でそこが単独の穴になる**ため1か所に置く。
#
# このファイル自体は実行せず、source して使う。
#
# `/proc` を読むためLinux専用。読めない環境では `dev_server_pid_matches` が常に偽を返し、
# **何も止めない側（安全側）に倒れる**。実行基盤はサブPC（Ubuntu）とWSLのいずれもLinux。

# 開発サーバーのログへ1行追記する。**止める前に必ず呼ぶ。**
#
# 無人実行では「なぜ開発サーバーが落ちているのか」がこのログにしか残らない。
# 勝手に落ちたのか回収されたのかが区別できないと、後から調査のしようがない（#1223）。
dev_server_log_event() {
  local log_file="$1" message="$2"
  local log_dir
  log_dir="$(dirname "$log_file")"
  [[ -d "$log_dir" ]] || mkdir -p "$log_dir" 2>/dev/null || return 0
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$message" >>"$log_file" 2>/dev/null || true
  return 0
}

# そのPIDを「このworktreeの開発サーバー」として止めてよいかを判定する。
#
# PIDファイルは後始末が通らないと残り続けるため、**書かれているPIDが再利用されて無関係な
# プロセスを指している**ことがありうる。プロセスグループごとkillする以上、外したときの被害が
# 大きい。次の2つを両方満たすときだけ真を返す。
#
#   - プロセスグループリーダーであること（pgid == pid）。`set -m` で起動した開発サーバーは
#     必ずそうなる（run-issue-session.sh）。無関係なプロセスがたまたま該当する確率は低い
#   - カレントディレクトリが対象のworktreeであること。`pnpm dev` はworktreeで起動される
dev_server_pid_matches() {
  local pid="$1" worktree_dir="$2" pgid cwd
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [[ "$pgid" == "$pid" ]] || return 1
  cwd="$(dev_server_cwd_of "$pid" || true)"
  [[ -n "$cwd" && "$cwd" == "$worktree_dir" ]] || return 1
  return 0
}

# そのPIDが開発サーバーの起動コマンド（`pnpm dev`など）かどうかを、**argvの位置**で判定する（#1525）。
#
# **コマンドラインの部分一致で探してはいけない。** `claude`はプロンプト全文をargvに持ち、そこには
# Issueの本文がそのまま入る。#1523の調査で`ps -eo pid,args | grep next-server`を叩いたところ、
# **#1524を担当している`claude`プロセス自身がヒットした**（本文中の`next-server`という記述に
# 当たったため）。同じ罠は scripts/lib/worktree-status.sh にも書かれている。
#
# `/proc/<pid>/cmdline`はNUL区切りなので、argvを要素として正確に取り出せる。要素そのものが
# `dev`と**一致**することを求めるため、本文に`pnpm dev`と書かれていても（それは1つの長い要素の
# 一部でしかなく）当たらない。見るのは先頭3つまで。`node`のようなインタプリタが1つ前に入る形も
# あるため、位置に幅を持たせている。
#
#   node /path/to/pnpm dev   /   pnpm dev   /   npm run dev   /   yarn dev   /   next dev
dev_server_is_dev_command() {
  local pid="$1" i arg base
  local -a argv=()
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  while IFS= read -r -d '' arg; do
    argv+=("$arg")
    # 判定に要るのは先頭5つまで。プロンプト全文のような巨大なargvを読み切らない
    [[ "${#argv[@]}" -lt 5 ]] || break
  done <"/proc/$pid/cmdline"

  for ((i = 0; i < ${#argv[@]} && i < 3; i++)); do
    base="${argv[i]##*/}"
    case "$base" in
      pnpm | pnpm.cjs | npm | npm-cli.js | yarn | yarn.js | bun | next) ;;
      *) continue ;;
    esac
    [[ "${argv[i + 1]:-}" == "dev" ]] && return 0
    if [[ "${argv[i + 1]:-}" == "run" && "${argv[i + 2]:-}" == "dev" ]]; then
      return 0
    fi
  done
  return 1
}

# そのPIDのカレントディレクトリ。取れなければ1を返す。
#
# **worktreeごと消えている場合、`readlink`は` (deleted)`を付けて返す**（#1525）。
# 「ディレクトリが消えたのに開発サーバーだけ残っている」は孤児のうちでも最も回収したい形
# （worktreeを消しても`pnpm dev`はポートとメモリを掴んだまま動き続ける）なので、印を落として
# 比較できるようにする。落とさないと`dev_server_pid_matches`が常に偽になり、
# reap-dev-servers.shは「別人」と見なしてPIDファイルだけ消し、プロセスは永久に残る。
dev_server_cwd_of() {
  local pid="$1" cwd
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -n "$cwd" ]] || return 1
  printf '%s' "${cwd%" (deleted)"}"
  return 0
}

# `tailscale serve`の転送先（`localhost:<ポート>`）に待ち受けが居るかを判定する（#1403）。
#
# **「そのポートに待ち受けが居るか」では判定できない。** `tailscale serve`自身がそのポートを
# tailnetのアドレス（`100.x.x.x:<ポート>`・`[fd7a:...]:<ポート>`）で待ち受けるため、serveが
# 残っている限り`ss`には必ず行が出る。孤児かどうかを行の有無で見ていた元の実装は、この条件が
# 常に真になり**孤児を一件も撤去できていなかった**（#1403で16件が滞留し、同じポートを使う
# worktreeの`pnpm dev`が`EADDRINUSE`で起動できなくなった）。
#
# 見るのはLocal Address列だけで、ループバック（`127.x` / `[::1]`）かワイルドカード
# （`*` / `0.0.0.0` / `[::]`）に張られたものだけを「転送先」と数える。**行全体をgrepしても
# いけない**（IPv4の行はPeer Address列が`0.0.0.0:*`なので、`0.0.0.0:`を含む正規表現は
# serve自身の行にも当たる）。`ss -tlnH`のLocal Address列は4番目のフィールド。
#
# `ss`が無い環境では判定できないため、**待ち受けが居る側（＝撤去しない安全側）に倒す**。
dev_server_loopback_listening() {
  local port="$1" addr
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 0
  command -v ss >/dev/null 2>&1 || return 0
  while read -r addr; do
    # 末尾の `:<ポート>` を落とす（IPv6は `[fd7a:...]:5403` の形なので後方一致で外す）
    addr="${addr%:*}"
    case "$addr" in
      '*' | '0.0.0.0' | '[::]' | '[::1]' | 127.*) return 0 ;;
    esac
  done < <(ss -tlnH "sport = :$port" 2>/dev/null | awk '{ print $4 }')
  return 1
}

# 開発サーバーをプロセスグループごと止める。**止まったことを確認するところまでを1つの処理にする。**
#
# `pnpm dev` は `next dev` → `next-server` と子を持つ。TERMを撃ちっぱなしにすると、
# 止まったつもりで残っていても気づけない。猶予（既定5秒）の後もいるならKILLへ上げる。
#
# 止まれば0、KILLしても残っていれば1を返す。
dev_server_stop_group() {
  local pid="$1" wait_seconds="${2:-5}" i
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < wait_seconds * 2; i++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  sleep 0.5
  if kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  return 0
}
