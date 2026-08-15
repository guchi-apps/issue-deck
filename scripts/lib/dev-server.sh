#!/usr/bin/env bash
# Issue専用worktreeの開発サーバー（`pnpm dev`）の止め方を共有する（#1223）。
#
# 次のスクリプトから source する。**止め方を何か所にも持つと、片方だけが緩んだ時点でそこが
# 単独の穴になる**ため1か所に置く。
#
#   scripts/run-issue-session.sh   セッション終了時・再開時の後始末
#   scripts/reap-dev-servers.sh    孤児とアイドルの回収
#   scripts/cleanup-worktrees.sh   worktreeを消す前の停止（#1524）
#   scripts/start-issue.sh         `--recreate`でworktreeを作り直す前の停止（#1524）
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
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [[ -n "$cwd" && "$cwd" == "$worktree_dir" ]] || return 1
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

# 対象Issueの開発サーバーが使うポート（#1524）。
#
# ポートは「ベース値 + Issue番号」で一意に決まる（scripts/local-repo-ports.conf・
# scripts/start-issue.sh）。**PIDファイルにはポートを書いていない**ため、PIDファイルを
# 持たない開発サーバー（後述の`dev_server_stop_by_port`）を引く唯一の手掛かりになる。
#
# ベース値は第2引数 → `ISSUE_DECK_DEV_PORT_BASE` → issue-deckの帯（4000）の順で決める。
dev_server_port_for_issue() {
  local issue_number="$1" base="${2:-${ISSUE_DECK_DEV_PORT_BASE:-4000}}"
  [[ "$issue_number" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$base" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$((base + issue_number))"
}

# そのポートで待ち受けているプロセスのPIDを列挙する（#1524）。
#
# `ss`が無い環境では何も出力しない（＝何も止めない側＝安全側に倒れる）。
#
# 待ち受けが1つも無いときは`grep`が1で終わる。**呼び出し元は`set -euo pipefail`**なので、
# そのまま返すとスクリプトごと落ちる。常に0で返し、「見つからなかった」は出力が空で表す。
#
# `tailscale serve`（#1403）はrootで動いていてPIDが見えないため、ここには出てこない。
# 見えたとしてもcwdの判定（`dev_server_stop_by_port`）で外れる。
dev_server_port_listener_pids() {
  local port="$1"
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 0
  command -v ss >/dev/null 2>&1 || return 0
  ss -tlnpH "sport = :$port" 2>/dev/null |
    grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
}

# そのPIDが開発サーバーの構成要素に見えるか（#1524）。
#
# **使うのは親を遡るときだけ**（`dev_server_tree_root`）。待ち受けている当人の判定には使わない
# （対象worktreeをcwdに持ち、そのIssueのポートを掴んでいる時点で開発サーバーとみなせる）。
# ここで効かせたいのは「どこで遡るのをやめるか」で、止め損ねより**巻き込みのほうが重い**。
#
# 実際のプロセスは3階建てで、コマンドラインは次のようになる。
#
#   node /…/bin/pnpm dev                  ← プロセスグループリーダー
#   node /…/next/dist/bin/next dev -p …   ← ラッパー
#   next-server (v16.2.12)                ← `ss`が返すのはこれ
#
# argv[0]が`node`のものがあるため、**argv[0]だけを見ても判定できない**。argv[1]までを見て、
# パッケージマネージャか開発サーバーのバイナリに当たるかで判断する。`next-server`は自分の名前を
# `next-server (v…)`へ書き換えるため、前方一致でも拾う。
#
# `claude`（argv[0]が`claude`）もBashツールのラッパーシェル（`/bin/bash -c …`）もどれにも
# 当たらないため、**cwdが同じworktreeでもここで遡りが止まる。**
dev_server_process_looks_like_dev() {
  local pid="$1" arg
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  local -a argv=()
  mapfile -t -n 2 argv < <(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "${#argv[@]}" -gt 0 ]] || return 1
  if [[ "${argv[0]}" == next-server* ]]; then
    return 0
  fi
  for arg in ${argv[@]+"${argv[@]}"}; do
    # `vite`は汎用ランチャー（#1224）が起こす他リポジトリの開発サーバー向け
    case "$(basename -- "$arg")" in
      pnpm | npm | yarn | next | next-server | vite) return 0 ;;
    esac
  done
  return 1
}

# 待ち受けているプロセスから、そのworktreeの開発サーバーの一番上の親まで遡る（#1524）。
#
# **一番下（`next-server`）だけ止めても足りない。** 親の`next dev`が生き残って次を起こす。
# 遡るのは「カレントディレクトリが対象のworktree」かつ「開発サーバーに見える」親だけで、
# そこで止まる。`claude`（cwdはworktreeだがコマンドラインが一致しない）やBashツールの
# ラッパーシェルはこの条件で外れるため、**セッション本体を巻き込まない。**
#
# ただし**親子の鎖の途中には開発サーバーに見えないものが挟まる。** issue-deckの実際の並びは
#
#   node /…/bin/pnpm dev              ← プロセスグループリーダー
#     sh -c …                         ← pnpmがスクリプトを起こすためのシェル
#       bash scripts/dev.sh           ← package.jsonの`dev`スクリプト
#         node /…/bin/next dev -p …
#           next-server (v16.2.12)
#
# で、`bash scripts/dev.sh`のところで遡りが止まる。そこで止めると`pnpm dev`と2つのシェルが
# 残る。**最後にプロセスグループのリーダーまで広げる**ことでここを繋ぐ。`set -m`で起こした
# 開発サーバーは一式が1つのプロセスグループになるため、リーダーが開発サーバーに見えるなら
# それが木の頂点でよい。エージェントが手で起こした場合はリーダーが`claude`になるが、
# そちらはコマンドラインの判定で外れるので広がらない。
#
# **リーダーだけが先に死んでいることがある**（#1523の調査中に実地で踏んだ形）。そのPIDは
# もう`/proc`に無いのでcwdが読めず、拡張は起きない。頂点は遡りが止まった`next dev`になり、
# その子孫（`next-server`）まで止まる。残った`sh -c`・`bash scripts/dev.sh`は子が終われば
# 自分も終わる。**`dev_server_stop_group`ではここを止められない**（リーダーが生きていることを
# 要求するため判定に失敗し、安全側に倒れて何もしない）。
dev_server_tree_root() {
  local pid="$1" worktree_dir="$2" root parent cwd pgid
  root="$pid"
  while :; do
    parent="$(ps -o ppid= -p "$root" 2>/dev/null | tr -d '[:space:]')"
    [[ "$parent" =~ ^[1-9][0-9]*$ ]] || break
    [[ "$parent" -gt 1 ]] || break
    cwd="$(readlink "/proc/$parent/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$worktree_dir" ]] || break
    dev_server_process_looks_like_dev "$parent" || break
    root="$parent"
  done

  pgid="$(ps -o pgid= -p "$root" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$pgid" =~ ^[1-9][0-9]*$ ]] && [[ "$pgid" != "$root" ]]; then
    cwd="$(readlink "/proc/$pgid/cwd" 2>/dev/null || true)"
    if [[ "$cwd" == "$worktree_dir" ]] && dev_server_process_looks_like_dev "$pgid"; then
      root="$pgid"
    fi
  fi

  printf '%s' "$root"
}

# プロセスとその子孫をまとめて止める（#1524）。
#
# **プロセスグループごとでは止められない場合がある。** 実装エージェントが画面確認のために
# 手で起こし直した`pnpm dev`は`claude`のプロセスグループに属するため、グループごと撃つと
# セッション本体まで巻き込む。木でたどれば、止める相手が起動経路によらず同じになる。
#
# 止まれば0、KILLしても残っていれば1を返す。
dev_server_stop_tree() {
  local root="$1" wait_seconds="${2:-5}"
  local -a queue=("$root") tree=()
  local pid child i remaining=0

  while [[ "${#queue[@]}" -gt 0 ]]; do
    pid="${queue[0]}"
    if [[ "${#queue[@]}" -gt 1 ]]; then
      queue=("${queue[@]:1}")
    else
      queue=()
    fi
    tree+=("$pid")
    while read -r child; do
      if [[ "$child" =~ ^[1-9][0-9]*$ ]]; then
        queue+=("$child")
      fi
    done < <(ps -o pid= --ppid "$pid" 2>/dev/null || true)
  done

  # 子から先にTERMする。親が生きているうちに子だけ落とすと起こし直されることがある。
  for ((i = ${#tree[@]} - 1; i >= 0; i--)); do
    kill -TERM "${tree[i]}" 2>/dev/null || true
  done
  for ((i = 0; i < wait_seconds * 2; i++)); do
    kill -0 "$root" 2>/dev/null || break
    sleep 0.5
  done

  for pid in ${tree[@]+"${tree[@]}"}; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
      remaining=1
    fi
  done
  if [[ "$remaining" -eq 1 ]]; then
    sleep 0.5
  fi
  for pid in ${tree[@]+"${tree[@]}"}; do
    if kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
  done
  return 0
}

# ポートを手掛かりに、そのworktreeの開発サーバーを止める（#1524）。
#
# **PIDファイルに頼る経路だけでは取りこぼす。** `run-issue-session.sh`が起こした開発サーバーは
# PIDファイルを持つが、実装エージェントが画面確認のために手で起こし直した`pnpm dev`は持たない。
# 後者はセッションが畳まれても誰も止めず、`reap-dev-servers.sh`（PIDファイルを走査する）からも
# 見えないまま残り続ける。#1523でOOM Killerを起こした孤児9本がこれにあたる。
#
# 触るのは**cwdが対象のworktreeである待ち受けプロセス**と、そこから遡れる開発サーバーの親だけ
# （`dev_server_tree_root`）。cwdを見るのがそのまま`tailscale serve`避けにもなる。serveは
# 同じポートをtailnetのアドレスで待ち受けるが（#1403）、cwdは`/`なのでここで外れる。
#
# 止めた本数だけログへ残す。**1本も見つからなければ何も書かない**（毎回のセッション終了で
# 「0本止めました」がログに積もらないようにする）。止めきれなければ1を返す。
dev_server_stop_by_port() {
  local port="$1" worktree_dir="$2" log_file="${3:-}" reason="${4:-セッションの終了}"
  local pid root known cwd seen failed=0
  local -a roots=()

  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 0
  [[ -n "$worktree_dir" ]] || return 0

  while read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    [[ "$cwd" == "$worktree_dir" ]] || continue
    root="$(dev_server_tree_root "$pid" "$worktree_dir")"
    # 同じ木を二度撃たない（1つのポートに複数のPIDがぶら下がることがある）
    seen=0
    for known in ${roots[@]+"${roots[@]}"}; do
      if [[ "$known" == "$root" ]]; then
        seen=1
        break
      fi
    done
    if [[ "$seen" -eq 0 ]]; then
      roots+=("$root")
    fi
  done < <(dev_server_port_listener_pids "$port")

  for root in ${roots[@]+"${roots[@]}"}; do
    if [[ -n "$log_file" ]]; then
      dev_server_log_event "$log_file" "${reason}に伴い、ポート $port を掴んでいた開発サーバー（PID $root とその子プロセス）を停止します。再び画面確認が必要になったら \`cd $worktree_dir && pnpm dev\` で起こしてください。"
    fi
    if ! dev_server_stop_tree "$root"; then
      failed=1
      if [[ -n "$log_file" ]]; then
        dev_server_log_event "$log_file" "ポート $port の開発サーバー（PID $root）はSIGKILLでも停止できませんでした。"
      fi
    fi
  done

  return "$failed"
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
