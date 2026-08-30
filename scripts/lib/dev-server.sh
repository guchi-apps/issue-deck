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
#
# **同じログへ書く開発サーバー側も必ずO_APPEND（`>>`）で開くこと（#1679）。** ここは`>>`で
# 常に末尾へ書くが、開発サーバーを`>`で起動するとそのfdは自分のオフセットを持つ。停止理由を
# 末尾へ追記した直後に、死にゆく開発サーバーが最後の出力を**理由の行より手前**へ書いて
# 上書きし、理由の行がマルチバイト文字の途中から壊れる（`.dev-servers/issue-1523.log`で実際に
# 発生）。起動側は scripts/run-issue-session.sh・scripts/start-preview-dev.sh。
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
#
# **`dev_server_process_looks_like_dev`（#1524）とは役割が違う。** あちらは「親を遡るのをどこで
# やめるか」を決める**緩い**判定で、`next-server`のような子も真になる。こちらは`/proc`全体を
# 走査する**入口**なので、`dev`という引数まで求めて厳しく絞る（`next build`のような別の用途で
# 動いているプロセスを候補にしない）。**入口を緩めない。**
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

# そのポートがワイルドカード（全インターフェース）で待ち受けているかを判定する（#1526）。
#
# 開発サーバーの待ち受けは`127.0.0.1`が既定になった（`scripts/dev.sh`）が、**worktreeは分岐した
# 時点のスクリプトを持ち続ける**ため、#1329より前に作られたworktreeで手で`pnpm dev`を叩くと
# 従来どおり全インターフェースに出る。Tailscaleに参加しているホストではtailnet上の他端末から
# 到達できてしまうので、回収の巡回（scripts/reap-dev-servers.sh）で見つけて知らせる。
#
# **具体的なアドレス（`100.x` / `[fd7a:...]`）は対象外。** それは`tailscale serve`自身の
# 待ち受けで、意図した公開にあたる。拾うのは`*` / `0.0.0.0` / `[::]`だけ。
#
# `ss`が無い環境では判定できないため、**出ていない側（＝警告しない安全側）に倒す**。
dev_server_wildcard_listening() {
  local port="$1" addr
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 1
  command -v ss >/dev/null 2>&1 || return 1
  while read -r addr; do
    addr="${addr%:*}"
    case "$addr" in
      '*' | '0.0.0.0' | '[::]') return 0 ;;
    esac
  done < <(ss -tlnH "sport = :$port" 2>/dev/null | awk '{ print $4 }')
  return 1
}

# ブラウザが接続を拒否するポート（#2466）。
#
# Chrome・Firefox・Safariは、他プロトコルの既定ポート（6000ならX11）へHTTPで繋ぐことを既定で
# 拒否する（Chromeなら`ERR_UNSAFE_PORT`）。**開発サーバーがそのポートで正しく待ち受けていても
# 画面は開けず、ホスト名がlocalhostでもtailnetのMagicDNS名でも同じ**なので、繋ぐ側では直せない。
# 払い出す側で避けるしかない。
#
# 載せるのは**1000以上のものだけ**。ポート帯のベース値は1000以上（scripts/local-repo-ports.conf）で、
# 実際のポートは「ベース値 + Issue番号」か「ベース値 + 0」なので、1000未満は出てこない。
#
# **この一覧はTypeScript側と二重に持っている**（src/lib/new-app/local-port-bands.ts の
# `BROWSER_BLOCKED_PORTS`）。帯を払い出すのは画面側、実際に起動するのはこちらで、片方だけ直すと
# 「払い出せた帯なのに確認環境が開けない」という形でずれる。突き合わせは
# src/lib/new-app/local-port-bands.test.ts が行うので、**変えるときは両方を揃える**。
DEV_SERVER_BROWSER_BLOCKED_PORTS="1719 1720 1723 2049 3659 4045 5060 5061 6000 6566 6665 6666 6667 6668 6669 6697 10080"

# そのポートがブラウザにブロックされるなら0を返す。
dev_server_browser_blocked_port() {
  local port="$1" blocked
  for blocked in $DEV_SERVER_BROWSER_BLOCKED_PORTS; do
    [[ "$port" == "$blocked" ]] && return 0
  done
  return 1
}

# ブラウザで開けるポートを返す。ブロックされるポートなら、開けるものが見つかるまで1ずつ繰り上げる。
#
# **繰り上げる（下げない）のは、帯の中で先に使われるのが小さいIssue番号だから。** 6000で塞がれる
# 確認環境（ベース値 + 0）は6001へ動くが、そこはIssue #1のセッションが使う値で、Issue番号は
# 単調増加するため実際に取り合いになることはまず無い。逆に下げると隣の帯（前のリポジトリの
# Issue #999）へはみ出す。
#
# 確認環境（ベース値 + 0）はこれを通る。Issueごとのセッションは帯の中で繰り上げる
# `dev_server_band_safe_port`（#2478）を通る。
dev_server_browser_safe_port() {
  local port="$1"
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 1
  while dev_server_browser_blocked_port "$port"; do
    port=$((port + 1))
  done
  printf '%s' "$port"
}

# 帯（`base`から`width`ぶん）の中でブラウザが開けるポートを返す（#2478）。
#
# `dev_server_browser_safe_port`との違いは**帯からはみ出さない**こと。帯の末尾がブロック対象
# だった場合、素朴に繰り上げると隣のリポジトリの帯へ食い込む（#2478でissue-deckの
# `4000 + 2470 = 6470`がdayspanの6000帯へ入っていたのと同じ壊れ方になる）。帯の端まで来たら
# ベース値 + 1へ折り返す（ベース値 + 0は確認環境が使うので飛ばす）。
#
# 帯が丸ごとブロック対象ということは起こらないが、無限ループを作らないよう1周で打ち切る。
dev_server_band_safe_port() {
  local port="$1" base="$2" width="$3" tried=0
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 1
  while dev_server_browser_blocked_port "$port"; do
    port=$((port + 1))
    if ((port >= base + width)); then
      port=$((base + 1))
    fi
    tried=$((tried + 1))
    ((tried < width)) || return 1
  done
  printf '%s' "$port"
}

# 対象Issueの開発サーバーが使うポート（#1524）。
#
# ポートはIssue番号から一意に決まる（scripts/local-repo-ports.conf・scripts/start-issue.sh）。
# **PIDファイルにはポートを書いていない**ため、PIDファイルを持たない開発サーバー
# （後述の`dev_server_stop_by_port`）を引く唯一の手掛かりになる。
#
# ベース値は第2引数 → `ISSUE_DECK_DEV_PORT_BASE` → issue-deckの帯（4000）の順で決める。
# 帯の幅は第3引数 → `ISSUE_DECK_DEV_PORT_WIDTH` → issue-deckの帯の幅（2000。ベース値を渡された
# 場合は原則の幅1000）の順で決める。
#
# **「ベース値 + Issue番号」は帯の中で折り返す**（#2478）。Issue番号は単調増加するので、素朴に
# 足すと必ずいつか帯の幅を超え、隣のリポジトリの帯へ食い込む（実際にissue-deckの
# `4000 + 2470 = 6470`がdayspanの6000帯に入り、dayspan #470と同じポートになっていた）。
# 折り返せば**どのIssue番号でも自分の帯から出ない**ため、帯の割り直しが要らなくなる。
#
#   オフセット = (Issue番号 - 1) mod (帯の幅 - 1) + 1     ポート = ベース値 + オフセット
#
# `- 1`が入るのは**ベース値 + 0を確認環境（`scripts/start-preview-dev.sh`）が使う**ため。
# オフセットは1〜(幅 - 1)を巡回する。帯の幅より小さいIssue番号では「ベース値 + Issue番号」と
# 一致するので、#1999までのissue-deckと他リポジトリのポートはこれまでと変わらない。
#
# **折り返した先は同じ帯の古いIssueのポートと重なる**（issue-deckなら1999番違い＝現在のペースで
# 約42日ぶん離れたIssue）。避けようがないのは繰り上げ（後述）と同じで、**重なった2つが同時に
# 起動していなければ実害は無い**。同時に起きた場合は`dev_server_wait_for_port`（#2464）が
# 検出し、`dev_server_port_owner_worktrees`（#2470）が相手のworktreeを名指しする。
#
# **ブラウザがブロックするポートに当たったら繰り上げる**（#2470）。折り返した後のポートも
# 6000以外のブロック対象に当たりうる（dayspan #566 → `6566`、dayspan #665〜#669 → IRCの
# `6665`〜`6669`、clip-hive #80 → `10080`）。開発サーバーは正しく待ち受けるが、画面が案内する
# URLをブラウザが開けない。**繰り上げも帯の中で行う**（`dev_server_band_safe_port`。#2478）。
#
# **採番する側と止める側の計算をこの関数だけに置くのが前提**（#2470）。片側にだけ繰り上げを
# 入れると、止める側が繰り上げ前のポートを探しに行って**起こしたセッションを止められなくなる**。
# 呼び出し元は次の3か所で、いずれも自前で`base + 番号`を計算しない。
#
#   scripts/start-issue.sh          issue-deck自身のセッションの採番と、`--recreate`前の停止
#   scripts/generic-start-issue.sh  汎用ランチャー（#1224）の採番
#   scripts/cleanup-worktrees.sh    worktreeを消す前の停止（#1524）
#
# **繰り上げた先・折り返した先は同じ帯の別Issueのポートと重なる**（`6566`→`6567`は#567、
# `6665`〜`6669`はまとめて`6670`で#670とも重なる）。これは避けようがない——帯の中のどのオフセットも
# 別のIssue番号でありうるため、帯の中に収まったまま衝突しない写像は作れない。
# **重なった2つが同時に起動していなければ実害は無い**ので、次の2つで受ける。
#
#   - 起動側: 掴めなかったことは`dev_server_wait_for_port`（#2464）が検出して警告する。
#     そのポートを別のworktreeが掴んでいれば`dev_server_port_owner_worktrees`が相手を添える
#   - 停止側: `dev_server_stop_by_port`はcwdで対象worktreeに絞るため、同じポートで待ち受けて
#     いる別Issueの開発サーバーを巻き込むことはない
dev_server_port_for_issue() {
  local issue_number="$1" base="${2:-}" width="${3:-}"
  if [[ -z "$base" ]]; then
    # 渡されない経路（issue-deck自身のstart-issue.shをターミナルから叩く等）では、
    # issue-deck自身の帯を既定値にする（#1178）。
    base="${ISSUE_DECK_DEV_PORT_BASE:-4000}"
    width="${width:-${ISSUE_DECK_DEV_PORT_WIDTH:-2000}}"
  else
    # ベース値を渡してくる経路（汎用ランチャー・cleanup-worktrees.sh）は対応表から引いている。
    # 幅も渡してくるのが正で、渡ってこなければ原則の幅（1000）に落とす。
    width="${width:-${ISSUE_DECK_DEV_PORT_WIDTH:-1000}}"
  fi
  [[ "$issue_number" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$base" =~ ^[0-9]+$ ]] || return 1
  [[ "$width" =~ ^[1-9][0-9]*$ ]] || return 1
  local span=$((width - 1))
  ((span >= 1)) || return 1
  dev_server_band_safe_port "$((base + (issue_number - 1) % span + 1))" "$base" "$width"
}

# 「ベース値 + Issue番号」と実際に使うポートが違うときに、その理由を1行で返す（#2478）。
# 同じなら1を返す（呼び出し側は何も出さない）。**採番と同じ理由をどの起動経路でも同じ文言で
# 出すため**、ここに置いて`start-issue.sh`・`generic-start-issue.sh`の両方から呼ぶ。
dev_server_port_note() {
  local issue_number="$1" base="$2" width="$3" port="$4"
  local natural=$((base + issue_number))
  [[ "$port" == "$natural" ]] && return 1
  if ((issue_number >= width)); then
    printf '%s' "Issue番号 $issue_number は帯の幅（$width）を超えるため、帯（$base〜$((base + width - 1))）の中で折り返して $port を使います（#2478）。"
  else
    printf '%s' "ポート $natural はブラウザが接続を拒否するため、$port を使います（#2470）。"
  fi
  return 0
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

# そのポートを掴んでいるプロセスのworktree（cwd）のうち、自分以外を列挙する（#2470）。
#
# 「ベース値 + Issue番号」がブロック対象に当たって繰り上がると、繰り上げ先は同じ帯の別Issueの
# ポートと重なる（`dev_server_port_for_issue`）。両方が同時に起動していると後から起こしたほうが
# ポートを掴めないため、**掴めなかったときに誰が掴んでいるのか**を警告へ添えるために使う。
#
# `ss`が無い環境と、掴んでいるのが自分だけの場合は何も出力しない。`tailscale serve`はrootで
# 動いていてPIDが見えないため、そもそもここには出てこない。
dev_server_port_owner_worktrees() {
  local port="$1" self="${2:-}" pid cwd
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 0
  while read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    cwd="$(dev_server_cwd_of "$pid" || true)"
    [[ -n "$cwd" ]] || continue
    [[ -n "$self" && "$cwd" == "$self" ]] && continue
    printf '%s\n' "$cwd"
  done < <(dev_server_port_listener_pids "$port") | sort -u
  return 0
}

# そのworktreeで動いているプロセスが待ち受けているTCPポートを列挙する（#2464）。
#
# 「起動したはずのポートに誰も居ない」ときに、**実際にはどこで待ち受けているのか**を
# 添えるために使う。ポートだけを見る`dev_server_port_listener_pids`とは向きが逆で、
# worktreeを手掛かりにポートを引く。
#
# `ss`が無い環境では何も出力しない（判定できないので黙る）。
dev_server_listening_ports_for_worktree() {
  local worktree_dir="$1" local_addr pid port cwd
  [[ -n "$worktree_dir" ]] || return 0
  command -v ss >/dev/null 2>&1 || return 0
  while read -r local_addr pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    cwd="$(dev_server_cwd_of "$pid" || true)"
    [[ "$cwd" == "$worktree_dir" ]] || continue
    # IPv6は `[::1]:3000` の形なので、最後の `:` から後ろを取る
    port="${local_addr##*:}"
    [[ "$port" =~ ^[1-9][0-9]*$ ]] || continue
    printf '%s\n' "$port"
  done < <(ss -tlnpH 2>/dev/null |
    awk '{ if (match($0, /pid=[0-9]+/)) print $4, substr($0, RSTART + 4, RLENGTH - 4) }') |
    sort -un
  return 0
}

# 起動した開発サーバーが、**意図したポートを実際に掴んだか**を待って確かめる（#2464）。
#
# PORTの受け渡しは環境変数とenvファイルの2経路あるが、**対象リポジトリの`dev`スクリプトが
# どちらも見ない**ことがある（`next dev`をポート決め打ちで叩いている、独自の変数名を使って
# いる等）。そのとき開発サーバー自体は起動するので「起動した」で先へ進んでしまい、待ち受けは
# 既定の3000のまま、画面・状態ファイル・tailnetのURLだけが指定したポートを指し続ける。
# #2464のguchi-apps/dayspanの確認環境がこれで、案内された6000には誰も居なかった。
#
# 掴めば0、猶予（既定30秒）の間に掴まなければ1を返す。**判定できない環境（`ss`が無い）では
# 0を返す**（起動を止めない側＝静かな側に倒す）。第4引数にPIDを渡すと、そのプロセスが
# 消えた時点で待つのをやめる（落ちた開発サーバーを猶予いっぱい待たない）。
dev_server_wait_for_port() {
  local port="$1" worktree_dir="$2" timeout_seconds="${3:-30}" pid="${4:-}" i found
  [[ "$port" =~ ^[1-9][0-9]*$ ]] || return 0
  command -v ss >/dev/null 2>&1 || return 0
  for ((i = 0; i < timeout_seconds * 2; i++)); do
    while read -r found; do
      [[ "$found" == "$port" ]] && return 0
    done < <(dev_server_listening_ports_for_worktree "$worktree_dir")
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.5
  done
  return 1
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
    cwd="$(dev_server_cwd_of "$parent" || true)"
    [[ "$cwd" == "$worktree_dir" ]] || break
    dev_server_process_looks_like_dev "$parent" || break
    root="$parent"
  done

  pgid="$(ps -o pgid= -p "$root" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$pgid" =~ ^[1-9][0-9]*$ ]] && [[ "$pgid" != "$root" ]]; then
    cwd="$(dev_server_cwd_of "$pgid" || true)"
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
    # `dev_server_cwd_of`を使うのは、**worktreeを消した後にも引けるようにする**ため（#1525）。
    # 消えたディレクトリを指すcwdは`readlink`が` (deleted)`を付けて返すので、生のまま比べると
    # 一致しない。cleanup-worktrees.shは消す前に呼ぶが、前回の削除で取りこぼした分をここで
    # 拾えるかどうかが変わる。
    cwd="$(dev_server_cwd_of "$pid" || true)"
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
