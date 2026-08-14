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
# **何も止めない側（安全側）に倒れる**。実行基盤はsubpc（Ubuntu）とWSLのいずれもLinux。

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
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -n "$cwd" && "$cwd" == "$worktree_dir" ]] || return 1
  return 0
}

# そのポートを**localhost経由で**待ち受けているプロセスが居るかを判定する（#1391）。
#
# `ss -tlnH "sport = :<ポート>"`にマッチする行が1つでもあれば現役、では足りない。
# `tailscale serve`を張ると**tailscaled自身がそのポートを掴む**ため、開発サーバーが死んでいても
# 条件が真になり続ける。実測（ポート5349・開発サーバー停止直後）。
#
#   LISTEN 0 4096         100.81.154.79:5349 0.0.0.0:*        # tailscaled
#   LISTEN 0 4096 [fd7a:115c:a1e0::7701:9acb]:5349 [::]:*     # tailscaled
#
# 孤児と判定されないままserveが残ると、tailnet IPを**具体的なアドレスとして**掴み続けるので、
# 次に`pnpm dev`（Next.jsの既定は全アドレス）を起こすと`EADDRINUSE`で落ちる。
#
# **数えるのはloopback（127.0.0.0/8・::1）とワイルドカード（0.0.0.0・::・*）の行だけ。**
# `tailscale serve`の転送先は`localhost:<ポート>`なので、「serveの繋がる先が居るか」は
# この条件と一致する。tailnet IPやLAN IPだけを掴んでいる行は転送先になりえないため数えない。
#
# 待ち受けが居れば0、居なければ1、`ss`が無くて**判定できなければ2**を返す。
# 呼び出し側は2を「居ない」と同じに扱わないこと（何も撤去しない側＝安全側に倒す）。
dev_server_localhost_listening() {
  local port="$1" addr
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 1
  command -v ss >/dev/null 2>&1 || return 2
  while read -r addr; do
    case "$addr" in
      127.*|'::1'|'[::1]'|0.0.0.0|'::'|'[::]'|'*') return 0 ;;
    esac
  done < <(ss -tlnH "sport = :$port" 2>/dev/null | awk '{ sub(/:[^:]*$/, "", $4); print $4 }')
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
