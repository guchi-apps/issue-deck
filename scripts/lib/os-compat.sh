#!/usr/bin/env bash
#
# ホストのOS差（Ubuntu＝サブPC／macOS＝Mac mini）を吸収する関数群（#5529）。
#
# pollerと周辺スクリプトは、もともとサブPC（Ubuntu・systemd）だけを前提に書かれており、
# `/proc`・`ss`・`systemctl`・GNU版の`date -d`/`stat -c`をそのまま使っている。macOSでは
# これらが無いか意味が違い、**多くは失敗せずに空や0へフォールバックして黙って誤った判定になる**。
# 呼び出し側がOSを意識しなくて済むよう、OSで分かれる取り方はここへ集める。
#
# - **Linuxの挙動は変えない。** Linuxの分岐は従来の各スクリプトの実装をそのまま移したもの
# - 取れなかったときの返し方（空・非0）は、呼び出し側が従来どおり「判定できない側」へ倒せる形に揃える
#
# このファイル自体は実行せず、source して使う。source した時点で次の2つを行う。
#   1. bash 4以降でなければ理由を出して終了する（`mapfile`・`declare -A`を使うスクリプトが多く、
#      macOS標準のbash 3.2では途中で構文エラーになり、どこで落ちたか分かりにくいため）
#   2. macOSでは、HomebrewのGNU coreutils（gnubin）・util-linux・Homebrew本体のbinをPATHの先頭へ置く
#      （`date -d`・`stat -c`・`timeout`・`setsid`・`flock`を、個々のスクリプトを直さずに通すため。
#      子プロセス〈tmuxサーバー・ランチャー・Claude Codeのセッション〉にもそのまま引き継がれる）

# 二重読み込みを避ける（ライブラリ同士が互いに source しても1回だけ評価する）
if [[ -n "${OS_COMPAT_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
OS_COMPAT_LOADED=1

# --- bash の版 ---------------------------------------------------------------
# `BASH_VERSINFO`はbash 2以降にある。ここだけはbash 3.2でも読める書き方にしておく
if [[ -z "${BASH_VERSINFO:-}" || "${BASH_VERSINFO[0]}" -lt 4 ]]; then
  echo "エラー: bash 4以降が必要です（いまは ${BASH_VERSION:-不明}）。macOSでは 'brew install bash' のうえ、Homebrewのbashを PATH の先頭に置いてください（#5529）。" >&2
  # `return`では source した側がそのまま先へ進み、後で構文エラーとして落ちる。ここで止める
  exit 1
fi

# OSの種類（`uname -s`）。1度だけ調べる
OS_COMPAT_KERNEL="${OS_COMPAT_KERNEL:-$(uname -s 2>/dev/null || echo unknown)}"

os_compat_is_darwin() {
  [[ "$OS_COMPAT_KERNEL" == "Darwin" ]]
}

os_compat_is_linux() {
  [[ "$OS_COMPAT_KERNEL" == "Linux" ]]
}

# --- PATH --------------------------------------------------------------------
# macOSだけ、存在するディレクトリを先頭へ足す（既に入っていれば足さない）。Linuxでは何もしない。
os_compat_setup_path() {
  os_compat_is_darwin || return 0
  local prefix dir
  local -a dirs=()
  for prefix in "${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local; do
    [[ -n "$prefix" && -d "$prefix" ]] || continue
    dirs=(
      "$prefix/opt/coreutils/libexec/gnubin"
      "$prefix/opt/gnu-sed/libexec/gnubin"
      "$prefix/opt/util-linux/bin"
      "$prefix/opt/gettext/bin"
      "$prefix/bin"
    )
    break
  done
  # 逆順に先頭へ積むと、配列の順（gnubin が最優先）になる
  local i
  for ((i = ${#dirs[@]} - 1; i >= 0; i--)); do
    dir="${dirs[i]}"
    [[ -d "$dir" ]] || continue
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) PATH="$dir:$PATH" ;;
    esac
  done
  export PATH
}
os_compat_setup_path

# 検証対象のCIが使うNodeのメジャー版（`node-version: "N"`）を、worktreeの`ci.yml`から読んで返す。読めなければ非0。
os_compat_ci_node_major() {
  local worktree="$1" value
  value="$(grep -m1 -E '^[[:space:]]*node-version:[[:space:]]*"?[0-9]+' "$worktree/.github/workflows/ci.yml" 2>/dev/null |
    sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

# macOSだけ、HomebrewのNode（`node@<メジャー版>`）をPATHの先頭へ置く（#5549）。
# Homebrewの`node`は常に最新版（Node 26では`localStorage`が`--localstorage-file`なしで無効になり、
# CI＝Node 24で通るjsdomのテストが大量に落ちる）。無ければ何もしない（Linuxも同様）。
os_compat_use_node_major() {
  os_compat_is_darwin || return 0
  local major="$1" prefix dir
  [[ "$major" =~ ^[0-9]+$ ]] || return 0
  for prefix in "${HOMEBREW_PREFIX:-}" /opt/homebrew /usr/local; do
    dir="$prefix/opt/node@$major/bin"
    [[ -n "$prefix" && -d "$dir" ]] || continue
    case ":$PATH:" in
      *":$dir:"*) PATH="$dir:${PATH//:$dir:/:}" ;;
      *) PATH="$dir:$PATH" ;;
    esac
    export PATH
    return 0
  done
  return 0
}

# --- 時刻・ファイル -----------------------------------------------------------

# `*.jsonl`を「更新時刻(epoch秒)<TAB>パス」の行で列挙する（#5549）。
#   os_compat_find_mtime <置き場> <最小の深さ> <最大の深さ>
# GNUのfindは`-printf`で出せるが、BSDのfind（macOS）には`-printf`が無く、**エラーを捨てると何も出ない**
# （転記を数えられず、使用量が黙って0になる）。BSDではstatで同じ形に揃える。
# GNUのstat（coreutilsのgnubin）では`-f`の意味が違うので、macOSでは必ず`/usr/bin/stat`を指す。
os_compat_find_mtime() {
  local dir="$1" mindepth="$2" maxdepth="$3"
  if find /dev/null -maxdepth 0 -printf '' >/dev/null 2>&1; then
    find "$dir" -mindepth "$mindepth" -maxdepth "$maxdepth" -name '*.jsonl' -printf '%T@\t%p\n' 2>/dev/null
  else
    find "$dir" -mindepth "$mindepth" -maxdepth "$maxdepth" -name '*.jsonl' \
      -exec /usr/bin/stat -f '%m%t%N' {} + 2>/dev/null
  fi
}

# ファイルの更新時刻（epoch秒）。取れなければ非0で終わり、何も出力しない。
os_compat_mtime() {
  local path="$1" value
  value="$(stat -c %Y "$path" 2>/dev/null || stat -f %m "$path" 2>/dev/null || true)"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

# 「N日前のローカル時刻0:00」（epoch秒）。取れなければ非0で終わる。
os_compat_days_ago_midnight() {
  local days="$1" value
  [[ "$days" =~ ^[0-9]+$ ]] || return 1
  if value="$(date -d "$days days ago 00:00" +%s 2>/dev/null)"; then
    :
  else
    # BSDのdate: 日付を戻してから時刻を0:00に合わせる
    value="$(date -v-"${days}"d -v0H -v0M -v0S +%s 2>/dev/null || true)"
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

# epoch秒をUTCのISO 8601（`2026-01-02T03:04:05Z`）に直す。
os_compat_epoch_to_utc_iso() {
  local epoch="$1"
  [[ "$epoch" =~ ^[0-9]+$ ]] || return 1
  date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null
}

# --- ホストの状態 -------------------------------------------------------------

# 起動時刻（epoch秒）。Linuxは`/proc/stat`の`btime`、macOSは`kern.boottime`。
os_compat_boot_epoch() {
  local value=""
  if os_compat_is_darwin; then
    value="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9]*\).*/\1/p')"
  else
    value="$(awk '/^btime /{print $2}' /proc/stat 2>/dev/null || true)"
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

# CPU使用率（%・小数1桁）。約1秒かけて測る。取れなければ非0。
#
# Linuxは`/proc/stat`のアイドル時間と全体の累積を1秒あけて2回読み、差分から出す（従来どおり）。
# macOSは累積値を読む手段が無いため、`top -l 2`の2回目のサンプル（user＋sys）を使う
# （1回目は起動直後の平均で不正確。status-hubの`scripts/host-stats/agent-macos.sh`と同じ取り方）。
os_compat_cpu_percent() {
  if os_compat_is_darwin; then
    local value
    value="$(top -l 2 -n 0 -s 1 2>/dev/null |
      awk -F'[ %]+' '/^CPU usage:/ { user = $3; sys = $5; seen = 1 } END { if (seen) printf "%.1f", user + sys }')"
    [[ -n "$value" ]] || return 1
    printf '%s' "$value"
    return 0
  fi

  local first second
  first="$(awk '/^cpu / { idle = $5 + $6; total = 0; for (i = 2; i <= NF; i++) total += $i; print idle, total; exit }' /proc/stat 2>/dev/null)" || return 1
  [[ -n "$first" ]] || return 1
  sleep 1
  second="$(awk '/^cpu / { idle = $5 + $6; total = 0; for (i = 2; i <= NF; i++) total += $i; print idle, total; exit }' /proc/stat 2>/dev/null)" || return 1
  [[ -n "$second" ]] || return 1
  awk -v first="$first" -v second="$second" 'BEGIN {
    split(first, a, " "); split(second, b, " ");
    idle = b[1] - a[1]; total = b[2] - a[2];
    if (total <= 0) exit 1;
    value = (1 - idle / total) * 100;
    if (value < 0) value = 0; if (value > 100) value = 100;
    printf "%.1f", value;
  }'
}

# メモリの「総量 使用量」（MB・整数・空白区切り）。取れなければ非0。
#
# Linuxの使用量は MemTotal − MemAvailable（キャッシュを空きとして数える。従来どおり）。
# macOSはActivity Monitorの「使用中のメモリ」に合わせ、アクティブ＋Wired＋圧縮の合計とする
# （非アクティブは再利用できるキャッシュなので使用中に数えない。status-hubと同じ）。
os_compat_memory_mb() {
  if os_compat_is_darwin; then
    local total vmstat page_size
    total="$(sysctl -n hw.memsize 2>/dev/null || true)"
    [[ "$total" =~ ^[0-9]+$ ]] || return 1
    vmstat="$(vm_stat 2>/dev/null)" || return 1
    page_size="$(printf '%s\n' "$vmstat" | sed -n 's/.*page size of \([0-9]*\) bytes.*/\1/p')"
    [[ "$page_size" =~ ^[0-9]+$ ]] || page_size=4096
    printf '%s\n' "$vmstat" | awk -v total="$total" -v page="$page_size" '
      /^Pages active:/ { gsub(/\./, "", $3); used += $3 }
      /^Pages wired down:/ { gsub(/\./, "", $4); used += $4 }
      /^Pages occupied by compressor:/ { gsub(/\./, "", $5); used += $5 }
      END { printf "%d %d", total / 1048576, used * page / 1048576 }'
    return 0
  fi

  local total used
  total="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  used="$(awk '/^MemTotal:/ { total = $2 } /^MemAvailable:/ { printf "%d", (total - $2) / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  [[ -n "$total" && -n "$used" ]] || return 1
  printf '%s %s' "$total" "$used"
}

# SWAPの「総量 使用量」（MB・整数・空白区切り）。SWAPを持たない構成は`0 0`。取れなければ非0。
#
# macOSのSWAPは必要に応じて増える動的なファイルで、使っていなければ総量も0になる
# （`vm.swapusage`が`total = 0.00M`）。Linuxと同じく0は正常な値として返す。
os_compat_swap_mb() {
  if os_compat_is_darwin; then
    local line total used
    line="$(sysctl -n vm.swapusage 2>/dev/null || true)"
    [[ -n "$line" ]] || return 1
    total="$(printf '%s' "$line" | sed -n 's/.*total *= *\([0-9.]*\)M.*/\1/p')"
    used="$(printf '%s' "$line" | sed -n 's/.*used *= *\([0-9.]*\)M.*/\1/p')"
    [[ -n "$total" && -n "$used" ]] || return 1
    awk -v t="$total" -v u="$used" 'BEGIN { printf "%d %d", t, u }'
    return 0
  fi

  local total used
  total="$(awk '/^SwapTotal:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  used="$(awk '/^SwapTotal:/ { total = $2 } /^SwapFree:/ { printf "%d", (total - $2) / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  [[ -n "$total" && -n "$used" ]] || return 1
  printf '%s %s' "$total" "$used"
}

# worktree・開発サーバーが置かれるファイルシステムのマウント先（ディスク使用量を測る場所）。
# Linuxは`/`。macOSの`/`は読み取り専用のシステムボリュームで、ホーム以下は
# `/System/Volumes/Data`（データボリューム）にある。
os_compat_data_fs_path() {
  if os_compat_is_darwin && [[ -d /System/Volumes/Data ]]; then
    printf '/System/Volumes/Data'
  else
    printf '/'
  fi
}

# ホストの再起動コマンドの絶対パス。**sudoersに書く許可と1文字も違えられない**ため、
# OSごとの正規の置き場所を返す（Ubuntuは`/usr/sbin/reboot`、macOSは`/sbin/reboot`）。
os_compat_reboot_command() {
  if os_compat_is_darwin; then
    printf '/sbin/reboot'
  else
    printf '/usr/sbin/reboot'
  fi
}

# --- プロセス -----------------------------------------------------------------

# 動いているプロセスのPIDを1行1つで列挙する。
os_compat_list_pids() {
  if os_compat_is_darwin; then
    ps -axo pid= 2>/dev/null | tr -d ' ' | grep -E '^[1-9][0-9]*$' || true
    return 0
  fi
  local dir
  for dir in /proc/[0-9]*; do
    [[ -d "$dir" ]] || continue
    printf '%s\n' "${dir#/proc/}"
  done
}

# そのPIDのargvを**NUL区切り**で出力する。最大`max`要素（既定5）まで。取れなければ非0。
#
# Linuxは`/proc/<pid>/cmdline`をそのまま読む（要素の境界が正確に分かる）。
#
# **macOSでは要素の境界を正確に取れない**（`ps`は空白で連結した文字列しか返さない）。そこで
# 空白で区切ったうえで、**実行ファイル名（`comm`）が開発サーバーの起動に使われうるもの
# （node・pnpm・npm・yarn・bun・next・vite）でなければ何も返さない**。`claude`はプロンプト全文を
# argvに持つため、空白で区切るとプロンプト中の「pnpm dev」という語が要素に見えてしまう
# （dev-server.sh の`dev_server_is_dev_command`が避けている罠）。実行ファイル名で先に絞れば、
# `claude`・シェル・その他のプロセスの引数はそもそも読まない。
os_compat_pid_argv() {
  local pid="$1" max="${2:-5}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1

  if ! os_compat_is_darwin; then
    [[ -r "/proc/$pid/cmdline" ]] || return 1
    local arg count=0
    while IFS= read -r -d '' arg; do
      printf '%s\0' "$arg"
      count=$((count + 1))
      [[ "$count" -lt "$max" ]] || break
    done <"/proc/$pid/cmdline"
    [[ "$count" -gt 0 ]]
    return
  fi

  local comm base args
  comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
  [[ -n "$comm" ]] || return 1
  base="${comm##*/}"
  case "$base" in
    node | pnpm | npm | yarn | bun | next | next-server* | vite) ;;
    *) return 1 ;;
  esac
  args="$(ps -ww -o args= -p "$pid" 2>/dev/null || true)"
  [[ -n "$args" ]] || return 1
  local -a words=()
  read -r -a words <<<"$args"
  local i
  for ((i = 0; i < ${#words[@]} && i < max; i++)); do
    printf '%s\0' "${words[i]}"
  done
}

# そのPIDの起動からの経過秒数。取れなければ非0。
#
# Linuxの`ps -o etimes=`は秒を返すが、macOSの`ps`には`etimes`が無く、`etime`
# （`[[日-]時:]分:秒`）を秒へ直す。
os_compat_pid_elapsed_seconds() {
  local pid="$1" value
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  if os_compat_is_darwin; then
    value="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    value="$(awk -v t="$value" 'BEGIN {
      if (t !~ /^([0-9]+-)?([0-9]+:)?[0-9]+:[0-9]+$/) exit 1
      days = 0
      if (index(t, "-") > 0) { split(t, d, "-"); days = d[1]; t = d[2] }
      n = split(t, p, ":")
      if (n == 3) secs = p[1] * 3600 + p[2] * 60 + p[3]
      else secs = p[1] * 60 + p[2]
      printf "%d", days * 86400 + secs
    }')" || return 1
  else
    value="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  fi
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

# そのPIDのカレントディレクトリ。取れなければ非0。
#
# Linuxは`/proc/<pid>/cwd`のリンク先（ディレクトリが消えていると` (deleted)`が付くので落とす）。
# macOSは`lsof`の`cwd`記述子から読む。
os_compat_pid_cwd() {
  local pid="$1" cwd=""
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  if os_compat_is_darwin; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  else
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  fi
  [[ -n "$cwd" ]] || return 1
  printf '%s' "${cwd%" (deleted)"}"
}

# --- 待ち受けポート -----------------------------------------------------------

# 待ち受けポートを調べる手段（Linuxは`ss`、macOSは`lsof`）があるか。
os_compat_can_list_tcp() {
  if os_compat_is_darwin; then
    command -v lsof >/dev/null 2>&1
  else
    command -v ss >/dev/null 2>&1
  fi
}

# TCPで待ち受けているソケットを「ローカルアドレス<TAB>PID」の1行1件で出力する。
# 第1引数にポートを渡すと、そのポートだけに絞る。PIDが見えない（他ユーザー・root）行はPIDが空。
#
# ローカルアドレスの書式は`ss`に揃える（`127.0.0.1:3000`・`*:3000`・`[::1]:3000`・`[::]:3000`）。
#
# 判定できない環境（`ss`も`lsof`も無い）では非0で終わり、何も出力しない。呼び出し側は
# 従来の「`ss`が無い環境」と同じく安全側へ倒す。
os_compat_tcp_listeners() {
  local port="${1:-}"
  if [[ -n "$port" && ! "$port" =~ ^[1-9][0-9]*$ ]]; then
    return 0
  fi

  if os_compat_is_darwin; then
    command -v lsof >/dev/null 2>&1 || return 1
    local -a args=(-nP -sTCP:LISTEN -FpPn)
    if [[ -n "$port" ]]; then
      args+=(-iTCP:"$port")
    else
      args+=(-iTCP)
    fi
    # `-F`の出力は「p<PID>」の行に続いて、そのプロセスのソケットごとに「n<アドレス>」が並ぶ。
    # 同じソケットがIPv4・IPv6で2行出ることがあるため重複は落とす
    lsof "${args[@]}" 2>/dev/null | awk '
      /^p/ { pid = substr($0, 2); next }
      /^n/ {
        addr = substr($0, 2)
        line = addr "\t" pid
        if (!(line in seen)) { seen[line] = 1; print line }
      }' || true
    return 0
  fi

  command -v ss >/dev/null 2>&1 || return 1
  local -a ss_args=(-tlnpH)
  [[ -n "$port" ]] && ss_args+=("sport = :$port")
  ss "${ss_args[@]}" 2>/dev/null | awk '{
    pid = ""
    if (match($0, /pid=[0-9]+/)) pid = substr($0, RSTART + 4, RLENGTH - 4)
    print $4 "\t" pid
  }' || true
}

# --- 切り離したプロセス ---------------------------------------------------------

# 状態ファイル（PIDファイル等）の置き場。XDGに倣う。
os_compat_state_dir() {
  printf '%s' "${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck"
}
