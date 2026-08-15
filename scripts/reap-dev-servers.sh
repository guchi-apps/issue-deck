#!/usr/bin/env bash
# 実装セッションの開発サーバー（`pnpm dev`）を回収する（#1223）。
#
#   孤児（第0段階）    セッションが畳まれたのに残っている開発サーバーを止める
#   アイドル（第1段階） 作業が終わって誰も見ていない開発サーバーを、**セッションは残したまま**止める
#   定期掃除（#1525）  上のどちらにも載っていない開発サーバーを`/proc`の走査で見つけて止める
#
# 使い方:
#   scripts/reap-dev-servers.sh                   孤児とアイドルを回収する
#   scripts/reap-dev-servers.sh --dry-run         判定だけ表示し、何も止めない
#   scripts/reap-dev-servers.sh --idle-minutes 0  アイドルの回収を行わない（孤児だけ回収する）
#   scripts/reap-dev-servers.sh --orphan-grace-minutes 0  /procの走査を行わない
#   scripts/reap-dev-servers.sh --base <dir>      worktreeの置き場を指定する
#
# 環境変数:
#   ISSUE_DECK_WORKTREE_BASE           worktreeの置き場（既定: ~/apps/issue-deck-worktrees）
#   DEV_SERVER_IDLE_MINUTES            アイドルとみなすまでの分数（既定: 60・0で無効）
#   DEV_SERVER_ORPHAN_GRACE_MINUTES    /procの走査で止めるまでの猶予（既定: 30・0で無効）
#
# ## 在庫がPIDファイルだけでは足りない（#1525・#1523の実測）
#
# 上の2段の**在庫は`.dev-servers/issue-<番号>.pid`だけ**で、これを書くのは
# `scripts/run-issue-session.sh`しかない。一方、実装エージェントへ渡すプロンプトは
# 「一定時間アクセスが無いと自動停止されるので`cd <worktree> && pnpm dev`で起こしてよい」と
# 案内している。**エージェントが案内どおり起こし直した2本目は、PIDファイルにもログにも載らない。**
# セッションが畳まれても、この2段からは存在自体が見えず誰も止めない。
#
# つまり「アイドルで回収 → エージェントが起こし直す → セッション終了 → 永久に残る」というループに
# なっており、**回収の仕組みがあること自体が孤児の供給源**になっていた。2026-08-15の実測では
# #1510が3時間30分（518MB）・#1539が1時間04分（1180MB）、PIDファイルなしで残っていた（#1523）。
#
# そこで**在庫の取り方をもう1つ足す**（第3の経路）。周期を足すのではなく在庫を足すのが要点なので、
# systemd timerは新設せず、これまでどおりpollerの1巡に相乗りする（**同じ役を2つ作らない**。
# docs/multi-agent/gates.md「計器」）。
#
# 開発サーバーの回収に加えて、**繋がる先が居なくなった`tailscale serve`の公開（#1265）も撤去する**。
# こちらは起動途中のセッションを巻き込まないよう、**2回連続で孤児と判定したときだけ撤去する**
# （#1403）。手で流して溜まった分を片付けるときは2回続けて実行する。
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
# tailnetへの公開（#1265）の撤去にも同じ関数を使う。
# shellcheck source=scripts/lib/tailscale-serve.sh
source "$SCRIPT_DIR/lib/tailscale-serve.sh"

WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
IDLE_MINUTES="${DEV_SERVER_IDLE_MINUTES:-60}"
ORPHAN_GRACE_MINUTES="${DEV_SERVER_ORPHAN_GRACE_MINUTES:-30}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --idle-minutes)
      IDLE_MINUTES="${2:-}"
      shift 2 || true
      ;;
    --orphan-grace-minutes)
      ORPHAN_GRACE_MINUTES="${2:-}"
      shift 2 || true
      ;;
    --base)
      WORKTREE_BASE="${2:-}"
      shift 2 || true
      ;;
    *)
      echo "Usage: scripts/reap-dev-servers.sh [--dry-run] [--idle-minutes <分>] [--orphan-grace-minutes <分>] [--base <dir>]" >&2
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
# 同じ理由で、こちらは**猶予が0秒になると起動直後の開発サーバーを撃つ**。必ず確かめる。
if [[ ! "$ORPHAN_GRACE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Error: 定期掃除の猶予の分数は0以上の整数で指定してください: $ORPHAN_GRACE_MINUTES" >&2
  exit 1
fi

DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"
# **PIDファイルが1つも無くても終わらない**（#1525）。在庫がPIDファイルだけでないため、
# ここで抜けると`/proc`の走査に届かない。
HAS_PID_FILES=1
if [[ ! -d "$DEV_SERVER_DIR" ]]; then
  HAS_PID_FILES=0
  echo "情報: $DEV_SERVER_DIR は存在しません（PIDファイルによる回収は行いません）。"
fi

NOW="$(date +%s)"
IDLE_SECONDS=$((IDLE_MINUTES * 60))
CHECKED=0
STOPPED=0
# PIDファイルに載っていない孤児（#1525）。CHECKEDとは別に数える（在庫が別なので足すと二重になる）
UNTRACKED=0

# 止める。--dry-run では判定だけ出す。理由は必ずログにも残す（無人実行ではここにしか残らない）。
#
# **どの経路（PIDファイル・`/proc`の走査）から来ても、記録と後始末はここ1本にする。** 第1引数は
# 表示用のラベルで、`/proc`の走査は他リポジトリのIssueも扱うためリポジトリ名を添える。
# PIDファイルの置き場はログと同じディレクトリなので、パスはログから導ける（#1525）。
# 第6引数は止め方（`group`／`tree`）で、どちらの実体も scripts/lib/dev-server.sh にある。
stop_one() {
  local label="$1" pid="$2" log_file="$3" worktree_dir="$4" reason="$5" mode="${6:-group}"
  local stop_result_ok=0

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  $label: [dry-run] $reason のため停止する対象です（PID $pid）"
    return 0
  fi

  dev_server_log_event "$log_file" "開発サーバー（$pid）を回収しました: $reason。再び画面確認が必要になったら \`cd $worktree_dir && pnpm dev\` で起こしてください。"
  # **止め方の使い分け**（実体はどちらも scripts/lib/dev-server.sh）。PIDファイルの経路が指すのは
  # 必ず`run-issue-session.sh`が`set -m`で起こしたプロセスグループのリーダーなのでグループごと撃つ。
  # `/proc`の走査が拾うのは手で起こし直した分で、`claude`と同じプロセスグループに居ることがあり、
  # グループごと撃つとセッション本体を巻き込む。あちらは木でたどる（#1524）。
  if [[ "$mode" == "tree" ]]; then
    dev_server_stop_tree "$pid" && stop_result_ok=1
  else
    dev_server_stop_group "$pid" && stop_result_ok=1
  fi
  if [[ "$stop_result_ok" -eq 1 ]]; then
    echo "  $label: 開発サーバー（PID $pid）を停止しました: $reason"
    STOPPED=$((STOPPED + 1))
  else
    echo "  $label: 警告: 開発サーバー（PID $pid）を停止できませんでした: $reason" >&2
    dev_server_log_event "$log_file" "開発サーバー（$pid）はSIGKILLでも停止できませんでした。"
    return 0
  fi
  # 今止めたプロセスグループを指しているときだけ消す（PIDの再利用を疑う。判定は経路によらない）
  local pid_file="${log_file%.log}.pid"
  if [[ "$(cat "$pid_file" 2>/dev/null || true)" == "$pid" ]]; then
    rm -f "$pid_file"
  fi
  return 0
}

# tailnetへの公開（#1265）のうち、**繋がる先がもう無いもの**を外す。
#
# ポートとIssueの対応をここでは持たない（PIDファイルにポートを記録していない）ため、
# **今serveされているポートを列挙し、転送先（`localhost:<ポート>`）で誰も待ち受けていないものを
# 孤児とみなす**。セッションがSIGKILLで落ちてcleanupを通らなかった場合もここで拾える。
# 判定そのものは `dev_server_loopback_listening`（scripts/lib/dev-server.sh）が持つ。
#
# 外し忘れると繋がらないURLがtailnet上に残るだけでなく、**そのポートが恒久的に使えなくなる**。
# serveはtailnet IPを具体的なアドレスとして掴むため、`::`を要求する`next dev`は
# `EADDRINUSE`で起動できない（#1403・docs/multi-agent/local-quick-start.md）。
#
# **2回連続で孤児と判定したときだけ撤去する（#1403）。** run-issue-session.shは開発サーバーを
# 起こした直後にserveを張るが、`next dev`が実際にbindするまでには数秒〜十数秒かかる。
# pollerの1巡（既定60秒）がその隙間に当たると、起動中のセッションのserveを外してしまう。
# 1回目は $SERVE_STRIKE_FILE に記録するだけにして、次の巡でも待ち受けが無いものを撤去する。
SERVE_STRIKE_FILE="$DEV_SERVER_DIR/orphan-serve-strikes"

reap_orphan_serves() {
  local port removed=0
  local -A struck=()
  local -a next_strikes=()

  if [[ -f "$SERVE_STRIKE_FILE" ]]; then
    while read -r port; do
      # `[[ ... ]] && ...` にすると、数字でない行でループ本体の終了ステータスが1になり
      # errexitでスクリプトごと落ちる。ifで書く
      if [[ "$port" =~ ^[1-9][0-9]*$ ]]; then
        struck["$port"]=1
      fi
    done <"$SERVE_STRIKE_FILE"
  fi

  while read -r port; do
    [[ "$port" =~ ^[1-9][0-9]*$ ]] || continue
    # 転送先に待ち受けが居るなら現役。`ss`が無い環境でも同じ扱い（触らない）
    if dev_server_loopback_listening "$port"; then
      continue
    fi
    # 1回目は記録だけ。起動途中のセッションを巻き込まないための猶予
    if [[ -z "${struck[$port]:-}" ]]; then
      next_strikes+=("$port")
      echo "  情報: tailnetへの公開（ポート $port）は転送先（localhost:$port）に待ち受けがありません。次の回も同じなら撤去します。"
      continue
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  [dry-run] tailnetへの公開（ポート $port）は転送先（localhost:$port）に待ち受けが無いため撤去する対象です"
      continue
    fi
    tailscale_serve_unpublish "$port"
    echo "  tailnetへの公開（ポート $port）を撤去しました: 転送先（localhost:$port）に待ち受けが無い（孤児）"
    removed=$((removed + 1))
  done < <(tailscale_serve_ports)

  # **--dry-run では記録も書き換えない。** 判定だけ表示する約束なので、次の実行の挙動も変えない
  if [[ "$DRY_RUN" -eq 0 ]]; then
    if [[ "${#next_strikes[@]}" -gt 0 ]]; then
      printf '%s\n' "${next_strikes[@]}" >"$SERVE_STRIKE_FILE"
    else
      rm -f "$SERVE_STRIKE_FILE"
    fi
  fi

  [[ "$removed" -eq 0 ]] || echo "tailnetへの公開を撤去しました: $removed 件"
}

# 待ち受けが全インターフェースに出ていないか警告する（#1526）。**孤児かどうかとは独立に見る。**
#
# 開発サーバーの待ち受けは`127.0.0.1`が既定になった（scripts/dev.sh）が、**worktreeは分岐した
# 時点のスクリプトを持ち続ける**ため、#1329より前に作られたworktreeで手で`pnpm dev`を叩くと
# 従来どおり全インターフェースに出る。Tailscaleに参加しているホストではtailnet上の他端末から
# 到達できてしまうので、pollerの1巡で見つけて知らせる。
#
# `/proc`の走査（`reap_untracked_dev_servers`）はargvの位置から入るためポート番号を持たず、
# `dev_server_wildcard_listening`にそのまま渡せない。ここは元の
# `scripts/sweep-orphan-dev-servers.sh`（developで削られた#1525・#1526）と同じく`ss -tlnp`から
# 入り、Local Address列からポートを、cwdからリポジトリ名とIssue番号を決める。
#
# **止めない。** 掃除の判定材料はtmuxセッションの有無と猶予だけに保つ（画面確認中のものを
# 誤って撃たない）。**worktreeのログにも書かない**（ログのmtimeはアイドル判定の材料で、
# ここで毎回書くとアイドルでの回収が永久に成立しなくなる）。
warn_wildcard_listening() {
  command -v ss >/dev/null 2>&1 || return 0

  local local_addr proc_info pid port cwd leaf worktree_base issue_number repo
  local -A seen_pid=()

  while read -r local_addr proc_info; do
    [[ "$proc_info" =~ pid=([0-9]+) ]] || continue
    pid="${BASH_REMATCH[1]}"
    # 同じプロセスがIPv4/IPv6の両方で待ち受けていることがある。1回だけ見る
    [[ -z "${seen_pid[$pid]:-}" ]] || continue
    seen_pid["$pid"]=1

    port="${local_addr##*:}"
    [[ "$port" =~ ^[1-9][0-9]*$ ]] || continue

    cwd="$(dev_server_cwd_of "$pid" || true)"
    [[ -n "$cwd" ]] || continue
    leaf="${cwd##*/}"
    worktree_base="${cwd%/*}"
    [[ "$leaf" =~ ^issue-([1-9][0-9]*)$ ]] || continue
    issue_number="${BASH_REMATCH[1]}"
    [[ "${worktree_base##*/}" =~ ^(.+)-worktrees$ ]] || continue
    repo="${BASH_REMATCH[1]}"

    dev_server_wildcard_listening "$port" || continue
    echo "警告: 開発サーバーがポート $port を全インターフェースで待ち受けています（$repo #$issue_number）。tailnet上の他端末から到達できます（#1526）。"
    echo "      $cwd の scripts/dev.sh が古い可能性があります。git -C $cwd merge origin/develop で取り込むか、worktreeを作り直してください。"
  done < <(ss -tlnpH 2>/dev/null | awk '{ rest = ""; for (i = 5; i <= NF; i++) rest = rest $i; print $4, rest }')

  return 0
}

# 在庫の第3の経路: `/proc`の走査（#1525）。PIDファイルに載っていない開発サーバーを見つける。
#
# ## 探し方（**コマンドラインの部分一致で探さない**）
#
# `claude`はプロンプト全文をargvに持ち、そこにはIssueの本文がそのまま入る。実際、#1523の調査で
# `ps -eo pid,args | grep next-server`が**#1524を担当している`claude`自身に当たった**
# （本文中の`next-server`という記述に当たったため。同じ罠は scripts/lib/worktree-status.sh にも
# 書かれている）。`dev_server_is_dev_command`は`/proc/<pid>/cmdline`をNUL区切りで読み、
# **argvの位置**で判定するので、本文の文字列では偽装できない。
#
# ## 止めてよいと判断する条件（**すべて**満たすもの以外は触らない）
#
#   1. argvの位置で開発サーバーの起動コマンドだと確定できる
#   2. `/proc/<pid>/cwd`が`<repo>-worktrees/issue-<番号>`である（**worktreeごと消えていても拾う**）
#   3. プロセスグループのリーダーが同じcwdに居て、リーダー自身も1を満たす
#   4. 対応するtmuxセッション（`<repo>-issue-<番号>`）が無い
#   5. 起動から猶予（既定30分）以上が経っている
#
# **ここでPPIDを使わない理由**（第0段階とは判定が違う）。PPID==1が孤児の証拠になるのは、
# PIDファイルに載る開発サーバーが必ず`run-issue-session.sh`の子で、セッションが生きている間は
# 親も生きているからである。**この経路が拾うのは手で起こし直された2本目**で、起こした側の
# シェルが先に抜けるとセッションが生きていてもPPIDは1になる。PPIDで判定すると、作業中の
# セッションの開発サーバーを撃つ。**セッションが在るかどうかを直接見るのが正確。**
#
# 4のセッション名は**cwdのパスから導く**（`<repo>-worktrees` → `<repo>-issue-<番号>`）ので、
# #1224で壊れた「リポジトリ名→セッション名の対応表」は増えない。
#
# tmuxのセッション一覧は1度だけ取り、**取れなければこの経路は丸ごと行わない**。`has-session`を
# 1件ずつ叩くと、tmuxサーバーが一時的に応答しない間の失敗が「セッションが無い（＝孤児）」に見え、
# 生きているセッションの開発サーバーを軒並み撃つ。「サーバーが動いていない」だけはセッションが
# 1つも無いことの確定した表明なので、その場合に限り空の一覧として扱う。
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

session_alive() {
  local name="$1" line
  [[ -n "$TMUX_SESSIONS" ]] || return 1
  while IFS= read -r line; do
    [[ "$line" == "$name" ]] && return 0
  done <<<"$TMUX_SESSIONS"
  return 1
}

reap_untracked_dev_servers() {
  local grace_seconds=$((ORPHAN_GRACE_MINUTES * 60))
  local proc_dir pid root cwd leaf base repo issue_number session etimes reason
  local worktree_base log_file
  local -A seen_root=()

  [[ "$grace_seconds" -gt 0 ]] || return 0

  if ! collect_tmux_sessions; then
    echo "  情報: tmuxのセッションを確認できないため、/procの走査は行いません（安全側）。" >&2
    return 0
  fi

  shopt -s nullglob
  for proc_dir in /proc/[0-9]*; do
    pid="${proc_dir#/proc/}"

    # 1. argvの位置で開発サーバーだと確定できるか（部分一致では探さない）
    dev_server_is_dev_command "$pid" || continue

    # 2. cwdがIssue専用worktreeか。`<repo>-worktrees/issue-<番号>`という置き場の規約から
    #    リポジトリ名とIssue番号の両方が決まる（scripts/start-issue.sh・generic-start-issue.sh）。
    #    **ポート番号からIssue番号を逆算しない**（ポートは「リポジトリごとのベース値 + Issue番号」で
    #    帯の幅も一定でないため、ポートだけでは複数のリポジトリに当てはまりうる）
    cwd="$(dev_server_cwd_of "$pid" || true)"
    [[ -n "$cwd" ]] || continue
    leaf="${cwd##*/}"
    worktree_base="${cwd%/*}"
    [[ "$leaf" =~ ^issue-([1-9][0-9]*)$ ]] || continue
    issue_number="${BASH_REMATCH[1]}"
    base="${worktree_base##*/}"
    [[ "$base" =~ ^(.+)-worktrees$ ]] || continue
    repo="${BASH_REMATCH[1]}"

    # 3. 止める範囲を決める。**プロセスグループごとには撃たない**（#1524）。エージェントが手で
    #    起こし直した`pnpm dev`は`claude`のプロセスグループに属することがあり、グループごと撃つと
    #    セッション本体を巻き込む。`dev_server_tree_root`は「cwdが同じworktree」かつ
    #    「開発サーバーに見える」親までしか遡らないので、`claude`もBashツールのラッパーシェルも
    #    そこで外れる。**リーダーだけが先に死んでいる形**（#1523で実地に踏んだ）もこれで止まる
    root="$(dev_server_tree_root "$pid" "$cwd")"
    [[ "$root" =~ ^[1-9][0-9]*$ ]] || continue
    [[ -z "${seen_root[$root]:-}" ]] || continue
    seen_root["$root"]=1

    # 4. セッションが在れば現役。PIDファイルに載っていないだけで、誰かが見ている
    session="${repo//[^A-Za-z0-9_-]/-}-issue-$issue_number"
    if session_alive "$session"; then
      continue
    fi

    # 5. 猶予。**セッションが立つ前の開発サーバーを撃たないための時間で、唯一の誤爆の防波堤。**
    #    開発サーバーとtmuxセッションのどちらが先に立つかは起動経路によって前後する
    etimes="$(ps -o etimes= -p "$root" 2>/dev/null | tr -d '[:space:]')"
    [[ "$etimes" =~ ^[0-9]+$ ]] || continue
    if [[ "$etimes" -lt "$grace_seconds" ]]; then
      echo "  $repo #$issue_number: tmuxセッション「$session」はありませんが、起動から $((etimes / 60))分（猶予 ${ORPHAN_GRACE_MINUTES}分）のため見送ります。"
      continue
    fi

    # **CHECKEDには足さない。** あちらはPIDファイルの件数で、生きているセッションの分まで
    # ここで数えると同じ開発サーバーを二重に数えることになる
    UNTRACKED=$((UNTRACKED + 1))
    reason="PIDファイルに無く、tmuxセッション「$session」も無い状態で $((etimes / 60))分動いていた（孤児）"
    log_file="$worktree_base/.dev-servers/issue-$issue_number.log"
    stop_one "$repo #$issue_number" "$root" "$log_file" "$cwd" "$reason" tree
  done

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
    stop_one "#$issue_number" "$pid" "$log_file" "$worktree_dir" "セッションが終了しても残っていた（孤児）"
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
    stop_one "#$issue_number" "$pid" "$log_file" "$worktree_dir" \
      "$((idle_for / 60))分アクセスが無くアイドルだった（セッションはそのまま残す）"
  fi
done

if [[ "$HAS_PID_FILES" -eq 1 ]]; then
  reap_orphan_serves
fi

# PIDファイルに載っていない分（#1525）。**PIDファイルの経路の後に走らせる。** 先に走らせると、
# PIDファイルのある開発サーバーをこちらが止めてしまい、PIDファイルだけが残る
reap_untracked_dev_servers

# 全インターフェースへの待ち受け警告（#1526）。停止とは無関係なので順序は問わない。
warn_wildcard_listening

echo "開発サーバーを確認しました: $CHECKED 件（PIDファイル）＋ $UNTRACKED 件（PIDファイルに無い孤児）・停止 $STOPPED 件・アイドル判定 ${IDLE_MINUTES}分・定期掃除の猶予 ${ORPHAN_GRACE_MINUTES}分"
