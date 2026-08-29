#!/usr/bin/env bash
# 確認環境（#2444）。**どのリポジトリでも**、developの最新状態をそのまま開ける開発サーバーとして
# 立てる。#1289で入ったissue-deck専用の `start-develop-dev.sh` を全リポジトリへ広げたもの。
#
# Issueごとの開発サーバー（scripts/start-issue.sh・run-issue-session.sh）は「実装中のブランチ」を
# 映すもので、**マージ済みの変更が積み上がったdevelopそのものを見る場所がなかった**。本体
# チェックアウト（~/apps/<repo>）で`pnpm dev`を叩くのは、そのときのブランチ・未コミットの
# 変更・ポートのどれもが手元の作業次第で変わるうえ、後始末の仕組み（PIDファイル・ログ）にも
# 載らないため、developを見る用途には使えない。
#
# 使い方:
#   scripts/start-preview-dev.sh [<owner>/<repo>]          最新のdevelopへ更新して（再）起動する
#   scripts/start-preview-dev.sh --status [<owner>/<repo>] 起動しているか・どのコミットかとURLを表示する
#   scripts/start-preview-dev.sh --status --json           動いている確認環境をJSONで返す（poller用）
#   scripts/start-preview-dev.sh --repos-json              確認環境を起こせるリポジトリをJSONで返す（poller用）
#   scripts/start-preview-dev.sh --stop [<owner>/<repo>]   停止する（省略時は動いているものを止める）
#   scripts/start-preview-dev.sh --no-update  今チェックアウトされている内容のまま再起動する
#   scripts/start-preview-dev.sh --no-migrate マイグレーションの適用（prisma migrate deploy）を行わない
#   scripts/start-preview-dev.sh --foreground この端末で動かす（Ctrl-Cで停止・ログは端末に出る）
#
# リポジトリを省略すると `guchi-apps/issue-deck` を対象にする（#1289当時の呼び方をそのまま
# 使えるようにするため）。
#
# 既定はバックグラウンド起動。**Tailscale SSHで入って叩き、SSHを切ってもそのまま残る**
# （`nohup`でSIGHUPを無視する）。tailnet内の端末からは
# `http://<MagicDNSの名前>:<ポート>` で開ける。
#
# **tailnetへ出す手段は`tailscale serve`（#1526）。** 以前は`next dev`の既定（全インターフェース）
# のまま出していたが、それだと同一LANの生IPからも見え、「意図して公開したもの」と「閉じ忘れ」の
# 区別が付かなかった。#1526で`scripts/dev.sh`の既定を`127.0.0.1`にしたのに合わせ、ここも
# Issueごとのセッションと同じくserveの`localhost:<ポート>`へのproxyで出す。公開範囲は
# TailscaleのACLが保証する（docs/multi-agent/local-quick-start.md「Tailscale経由でスマホから画面を見る」）。
#
# ## 同時に動かせるのは1つだけ（#2444）
#
# サブPCの実効RAMは13Giしかなく、#1523ではIssueごとの開発サーバーの孤児9本でOOM Killerが
# 発動している。リポジトリ数ぶんの確認環境を常駐させる前提は置けないため、**別のリポジトリを
# 対象に起動すると、いま動いている確認環境を先に止める**。どれが動いているかは状態ファイル
# （`$ISSUE_DECK_PREVIEW_STATE_FILE`・既定は `~/.local/state/issue-deck/preview.env`）に持つ。
#
# 環境変数:
#   ISSUE_DECK_PREVIEW_STATE_FILE 動いている確認環境の記録先
#   ISSUE_DECK_WORKTREE_BASE      worktreeの置き場（既定: ~/apps/<repo>-worktrees）
#   ISSUE_DECK_DEVELOP_DEV_PORT   使うポート（既定: 帯のベース値 + 0。ブラウザがブロックするポートなら繰り上げる）
#   ISSUE_DECK_DEV_PORT_BASE      ポートのベース値（既定: scripts/local-repo-ports.conf の帯）
#   ISSUE_DECK_DEV_COMMAND        開発サーバーの起動コマンド（既定: 判定したパッケージマネージャ）
#   PREVIEW_IDLE_MINUTES          何分アクセスが無ければ回収するか（既定60・表示にのみ使う）
#
# **Issueごとのworktreeとは別のディレクトリ（`<置き場>/preview`）に、detached HEADで置く。**
# 同じブランチを2つの作業ツリーで開くことはgitが許さず（本体が`develop`を開いている）、
# detachedにしておけばここで誤ってコミットしても`develop`は動かない。ディレクトリ名が
# `issue-*`に一致しないため、scripts/cleanup-worktrees.sh の対象にもならない。
#
# ## 見られるのは読み取りの画面だけ（#2444）
#
# 確認環境が動かすのは**まだ本番へ出していないコード**なので、そこから実データへ書けてしまうと
# 「確かめるつもりの操作」がそのまま本番の変更になる。envへ`PREVIEW_MODE=true`を立て直して
# 書き込み系のAPI（POST/PATCH/DELETE）を403で塞ぐ（`src/lib/preview-mode.ts`）。DBも本体・各
# Issueのworktreeと共有している開発用DBなので、見えるのは開発用のデータ。
#
# 前提:
#   - 本体チェックアウトに `.env.local`（または `.env`）があること
#   - DBを使うリポジトリでは、ローカルのMySQLが起動していること（DBは本体・各Issueのworktreeと共有する）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 開発サーバーの止め方・PIDの持ち主判定は、Issueごとのセッション（run-issue-session.sh）・
# 回収スクリプト（reap-dev-servers.sh）と共有する。**止め方を増やさない**（#1223）。
# shellcheck source=scripts/lib/dev-server.sh
source "$SCRIPT_DIR/lib/dev-server.sh"
# 本体の .env.local からworktreeへ環境変数を供給する処理も、ランチャー群と共有する（#1099）。
# shellcheck source=scripts/lib/env-file-sync.sh
source "$SCRIPT_DIR/lib/env-file-sync.sh"
# tailnetへの公開もIssueごとのセッションと同じ関数で行う（#1265・#1526）。
# shellcheck source=scripts/lib/tailscale-serve.sh
source "$SCRIPT_DIR/lib/tailscale-serve.sh"
# チェックアウト先・ポート帯・パッケージマネージャの解決は受け口・汎用ランチャーと共有する
# （#1179・#1224）。**判定を二重に持つと、申告と実際の起動可否が必ずずれる。**
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"

DEFAULT_REPOSITORY="guchi-apps/issue-deck"
STATE_FILE="${ISSUE_DECK_PREVIEW_STATE_FILE:-$HOME/.local/state/issue-deck/preview.env}"

MODE=start
UPDATE=1
MIGRATE=1
FOREGROUND=0
JSON=0
TARGET=""

usage() {
  echo "Usage: scripts/start-preview-dev.sh [--status|--stop|--repos-json] [--json] [--no-update] [--no-migrate] [--foreground] [<owner>/<repo>]" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --status) MODE=status ;;
    --stop) MODE=stop ;;
    --repos-json) MODE=repos ;;
    --json) JSON=1 ;;
    --no-update) UPDATE=0 ;;
    --no-migrate) MIGRATE=0 ;;
    --foreground) FOREGROUND=1 ;;
    -*) usage ;;
    */*)
      [[ -z "$TARGET" ]] || usage
      TARGET="$arg"
      ;;
    *) usage ;;
  esac
done

# --- 状態ファイル -------------------------------------------------------------
# 動いている確認環境は**ホスト全体で1つ**なので、リポジトリごとではなく1枚のファイルに書く。
# 中身はシェルの代入（`printf '%q'`でクォート済み）で、読むときは`source`する。
#
# **このファイルの中身をそのまま信じない。** 後始末が通らずに残った記録が、既に死んだプロセスを
# 指していることがある（PIDファイルと同じ問題・#1223）。読んだ後に必ず`preview_running`で
# 実プロセスを確かめる。
PREVIEW_REPOSITORY=""
PREVIEW_WORKTREE=""
PREVIEW_PORT=""
PREVIEW_BRANCH=""
PREVIEW_COMMIT=""
PREVIEW_SUBJECT=""
PREVIEW_URL=""
PREVIEW_STARTED_AT=""
PREVIEW_LOG=""
PREVIEW_PID_FILE=""

load_state() {
  PREVIEW_REPOSITORY=""; PREVIEW_WORKTREE=""; PREVIEW_PORT=""; PREVIEW_BRANCH=""
  PREVIEW_COMMIT=""; PREVIEW_SUBJECT=""; PREVIEW_URL=""; PREVIEW_STARTED_AT=""
  PREVIEW_LOG=""; PREVIEW_PID_FILE=""
  [[ -f "$STATE_FILE" ]] || return 0
  # shellcheck disable=SC1090
  source "$STATE_FILE" 2>/dev/null || true
  return 0
}

save_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  {
    printf 'PREVIEW_REPOSITORY=%q\n' "$PREVIEW_REPOSITORY"
    printf 'PREVIEW_WORKTREE=%q\n' "$PREVIEW_WORKTREE"
    printf 'PREVIEW_PORT=%q\n' "$PREVIEW_PORT"
    printf 'PREVIEW_BRANCH=%q\n' "$PREVIEW_BRANCH"
    printf 'PREVIEW_COMMIT=%q\n' "$PREVIEW_COMMIT"
    printf 'PREVIEW_SUBJECT=%q\n' "$PREVIEW_SUBJECT"
    printf 'PREVIEW_URL=%q\n' "$PREVIEW_URL"
    printf 'PREVIEW_STARTED_AT=%q\n' "$PREVIEW_STARTED_AT"
    printf 'PREVIEW_LOG=%q\n' "$PREVIEW_LOG"
    printf 'PREVIEW_PID_FILE=%q\n' "$PREVIEW_PID_FILE"
  } >"$STATE_FILE"
}

clear_state() {
  rm -f "$STATE_FILE"
}

# 記録されている確認環境が実際に動いていれば、そのPIDを返す（無ければ何も返さない）。
preview_running() {
  local pid
  [[ -n "$PREVIEW_PID_FILE" && -f "$PREVIEW_PID_FILE" ]] || return 0
  pid="$(cat "$PREVIEW_PID_FILE" 2>/dev/null || true)"
  if dev_server_pid_matches "$pid" "$PREVIEW_WORKTREE"; then
    printf '%s' "$pid"
  fi
}

# --- リポジトリごとの値の解決 --------------------------------------------------
REPO_PATH=""
WORKTREE_DIR=""
DEV_PORT=""
DEV_COMMAND=""
BASE_BRANCH=""
DEV_LOG=""
DEV_PID_FILE=""

# `origin/HEAD`（GitHub側の既定ブランチ）を正とする。**リポジトリ名から決め打ちできない**
# （develop と main が混在する）。判定は汎用ランチャー（generic-start-issue.sh）と同じ。
resolve_base_branch() {
  local ref candidate
  ref="$(git -C "$REPO_PATH" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -z "$ref" ]]; then
    git -C "$REPO_PATH" remote set-head origin --auto >/dev/null 2>&1 || true
    ref="$(git -C "$REPO_PATH" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)"
  fi
  if [[ -n "$ref" ]]; then
    printf '%s\n' "${ref#refs/remotes/origin/}"
    return 0
  fi
  for candidate in develop main master; do
    if git -C "$REPO_PATH" show-ref --verify --quiet "refs/remotes/origin/$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# 対象リポジトリの置き場・ポート・起動コマンドを決める。解決できなければ1を返す。
resolve_target() {
  local full_name="$1" repo port_base default_port package_manager worktree_base

  if ! REPO_PATH="$(local_repo_resolve_path "$full_name")"; then
    echo "Error: $full_name のチェックアウト先が ~/.config/issue-deck/local-repos.conf にありません。" >&2
    return 1
  fi
  if [[ ! -d "$REPO_PATH/.git" && ! -f "$REPO_PATH/.git" ]]; then
    echo "Error: $REPO_PATH はgitのチェックアウトではありません。" >&2
    return 1
  fi

  repo="${full_name#*/}"
  worktree_base="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/$repo-worktrees}"
  WORKTREE_DIR="$worktree_base/preview"
  DEV_LOG="$worktree_base/.dev-servers/preview.log"
  DEV_PID_FILE="$worktree_base/.dev-servers/preview.pid"

  # Issue番号は1以上なので、帯のベース値そのもの（+0）はどのIssueのworktreeとも衝突しない。
  # 帯の一覧は scripts/local-repo-ports.conf を参照。
  #
  # **ベース値がブラウザのブロック対象なら繰り上げる**（#2466）。dayspanの帯は6000で、6000は
  # X11用としてChrome・Firefox・Safariが既定で拒否する（`ERR_UNSAFE_PORT`）。待ち受けが正しくても
  # 案内するURLを開けないので、ここで開けるポートへ寄せる（判定は scripts/lib/dev-server.sh）。
  # Issueごとのセッション（ベース値 + Issue番号）も同じ判定を通る（#2470。
  # `dev_server_port_for_issue`）。当たるのは6000だけではないため、そちらにも繰り上げが要る。
  port_base="${ISSUE_DECK_DEV_PORT_BASE:-$(local_repo_port_base "$full_name" || echo 3000)}"
  default_port="$(dev_server_browser_safe_port "$((port_base + 0))")"
  DEV_PORT="${ISSUE_DECK_DEVELOP_DEV_PORT:-$default_port}"
  if [[ -z "${ISSUE_DECK_DEVELOP_DEV_PORT:-}" && "$default_port" != "$((port_base + 0))" ]]; then
    echo "注記: ポート $((port_base + 0)) はブラウザが接続を拒否するため、$default_port を使います（#2466）。"
  fi

  # **開発サーバーを持たないリポジトリがある**（vps・subpc・docs・claude-config・ideas）。
  # 帯だけは確保してあるので、ポートは引けても起こすものが無い。ここで断ってしまう。
  package_manager="$(detect_package_manager "$REPO_PATH" || true)"
  if [[ -z "$package_manager" ]]; then
    echo "Error: $full_name には開発サーバーがありません（package.json が無いリポジトリです）。" >&2
    return 1
  fi
  if ! grep -q '"dev"[[:space:]]*:' "$REPO_PATH/package.json" 2>/dev/null; then
    echo "Error: $full_name の package.json に dev スクリプトがありません。" >&2
    return 1
  fi
  if [[ -n "${ISSUE_DECK_DEV_COMMAND:-}" ]]; then
    DEV_COMMAND="$ISSUE_DECK_DEV_COMMAND"
  elif [[ "$package_manager" == "pnpm" ]]; then
    DEV_COMMAND="pnpm dev"
  else
    DEV_COMMAND="$package_manager run dev"
  fi
  return 0
}

# 今チェックアウトしているコミットを1行で表す。どの時点のdevelopを見ているのかが、
# 画面を見ている最中にも確かめられるようにする。
head_summary() {
  git -C "${1:-$WORKTREE_DIR}" log -1 --format='%h %s' 2>/dev/null || echo "(不明)"
}

# アクセスURLを表示する。
#
# **出すのはMagicDNSのFQDN1本だけ（#1526）。** `tailscale serve`はHostヘッダーで振り分けるため
# 生のtailnet IPでは404になり、そもそも next.config.ts の allowedDevOrigins（`**.ts.net`）にも
# 当たらない。開けないURLを並べると、繋がらないときにどれを試せばよいか分からなくなる。
print_urls() {
  local port="$1" preview_url="${2:-}"
  echo "  http://localhost:$port"
  if [[ -n "$preview_url" ]]; then
    echo "  $preview_url  （tailnet内の端末からはこのURLを使う）"
  else
    echo "  （tailnetへの公開はありません。tailscale serve が使えないホストか、公開に失敗しています）"
  fi
}

# 今このポートが公開されているならそのURLを返す。公開が無ければ何も出さない。
current_preview_url() {
  local port="$1" host
  tailscale_serve_published "$port" || return 0
  host="$(tailscale_serve_hostname)"
  [[ -n "$host" ]] || return 0
  printf 'http://%s:%s' "$host" "$port"
}

# 動いている確認環境を止める。**記録が無い・既に死んでいる場合も0で返す**（呼び出し元は
# 「止まっている状態にする」ことだけを求めており、そこへ至った経緯で分岐しない）。
# 止めきれなかったときだけ1を返す。
stop_preview() {
  local reason="${1:-確認環境の停止}" pid failed=0
  load_state
  if [[ -z "$PREVIEW_REPOSITORY" ]]; then
    return 0
  fi

  # tailnetへの公開（#1526）は、プロセスが居ようが居まいが先に外す。**残すと繋がらないURLが
  # tailnet上に残るだけでなく、そのポートで次に`next dev`を起こせなくなる**（#1403）。
  if [[ -n "$PREVIEW_PORT" ]]; then
    tailscale_serve_unpublish "$PREVIEW_PORT"
  fi

  pid="$(preview_running)"
  if [[ -n "$pid" ]]; then
    dev_server_log_event "$PREVIEW_LOG" "${reason}に伴い、$PREVIEW_REPOSITORY の確認環境（プロセスグループ $pid）を停止します。"
    if ! dev_server_stop_group "$pid"; then
      echo "Error: 確認環境（PID $pid）を停止できませんでした。手動で確認してください。" >&2
      failed=1
    fi
  fi
  # PIDファイルを持たない起動（手で叩き直したもの）も、ポートとworktreeを手掛かりに止める（#1524）。
  if [[ -n "$PREVIEW_PORT" && -n "$PREVIEW_WORKTREE" ]]; then
    dev_server_stop_by_port "$PREVIEW_PORT" "$PREVIEW_WORKTREE" "$PREVIEW_LOG" "$reason" || failed=1
  fi

  [[ -n "$PREVIEW_PID_FILE" ]] && rm -f "$PREVIEW_PID_FILE"
  clear_state
  return "$failed"
}

# --- --repos-json -------------------------------------------------------------
# 確認環境を起こせるリポジトリをJSONの配列で返す（pollerが申告に使う）。
#
# **「開発サーバーを持たないリポジトリ」を画面の一覧から除くために要る**（#2444）。vps・subpc・
# docs・claude-config・ideas はローカルセッションのためにポート帯だけ確保してあるが、
# `package.json`が無いので起こすものが無い。申告の`repositories`（＝セッションを起こせる
# リポジトリ）をそのまま一覧に並べると、押しても必ず失敗する行が混ざる。
#
# **判定を二重に持たない。** 起こせるかどうかを決めるのは`resolve_target`ひとつで、ここはその
# 判定を候補ぶん回すだけ（pollerの中に同じ条件を書くと、申告と実際の起動可否が必ずずれる）。
if [[ "$MODE" == "repos" ]]; then
  RUNNABLE=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    if resolve_target "$candidate" >/dev/null 2>&1; then
      RUNNABLE+=("$candidate")
    fi
  done < <(local_repo_list_runnable)
  if [[ "${#RUNNABLE[@]}" -eq 0 ]]; then
    printf '[]\n'
  else
    printf '%s\n' "${RUNNABLE[@]}" |
      python3 -c 'import json,sys; print(json.dumps([line.strip() for line in sys.stdin if line.strip()]))'
  fi
  exit 0
fi

# --- --status -----------------------------------------------------------------
if [[ "$MODE" == "status" ]]; then
  load_state
  pid="$(preview_running)"

  if [[ "$JSON" -eq 1 ]]; then
    # pollerがそのままissue-deckへ申告する形（`POST /api/dispatch/hosts`の`preview`）。
    # **動いていなければ`{"running": false}`**で、直前の記録は載せない（画面に残ると、
    # 止まっているものが動いているように見える）。
    if [[ -z "$pid" ]]; then
      printf '{"running":false}\n'
      exit 0
    fi
    PREVIEW_COMMIT="$(git -C "$PREVIEW_WORKTREE" log -1 --format='%h' 2>/dev/null || printf '%s' "$PREVIEW_COMMIT")"
    PREVIEW_SUBJECT="$(git -C "$PREVIEW_WORKTREE" log -1 --format='%s' 2>/dev/null || printf '%s' "$PREVIEW_SUBJECT")"
    PREVIEW_URL="$(current_preview_url "$PREVIEW_PORT")"
    # **自動停止までの分数は回収側（scripts/reap-dev-servers.sh）と同じ既定を使う。**
    # ここだけ別の値を出すと、画面が案内する時間と実際に止まる時間がずれる。
    python3 -c 'import json,sys
keys = ["repository","branch","port","url","commit","subject","startedAt","idleMinutes"]
values = sys.argv[1:]
out = {"running": True}
for key, value in zip(keys, values):
    if value == "":
        continue
    out[key] = int(value) if key in ("port", "idleMinutes") else value
print(json.dumps(out, ensure_ascii=False))' \
      "$PREVIEW_REPOSITORY" "$PREVIEW_BRANCH" "$PREVIEW_PORT" "$PREVIEW_URL" \
      "$PREVIEW_COMMIT" "$PREVIEW_SUBJECT" "$PREVIEW_STARTED_AT" "${PREVIEW_IDLE_MINUTES:-60}"
    exit 0
  fi

  if [[ -z "$pid" ]]; then
    echo "確認環境: 停止中"
    [[ -n "$PREVIEW_REPOSITORY" ]] && echo "  （最後に動いていたのは $PREVIEW_REPOSITORY）"
    exit 0
  fi
  echo "確認環境: 起動中（$PREVIEW_REPOSITORY・PID $pid・ポート $PREVIEW_PORT）"
  echo "  worktree: $PREVIEW_WORKTREE"
  echo "  HEAD: $(head_summary "$PREVIEW_WORKTREE")"
  echo "  ログ: $PREVIEW_LOG"
  print_urls "$PREVIEW_PORT" "$(current_preview_url "$PREVIEW_PORT")"
  exit 0
fi

# --- --stop -------------------------------------------------------------------
if [[ "$MODE" == "stop" ]]; then
  load_state
  if [[ -z "$PREVIEW_REPOSITORY" ]]; then
    echo "確認環境は起動していません。"
    exit 0
  fi
  # リポジトリを指定して止める場合、**別のリポジトリが動いていたら何もしない。**
  # 画面の「停止」は見えているものを止める操作で、知らないうちに別のものを止めない。
  if [[ -n "$TARGET" && "$TARGET" != "$PREVIEW_REPOSITORY" ]]; then
    echo "確認環境は $PREVIEW_REPOSITORY で動いています（$TARGET ではないため何もしません）。"
    exit 0
  fi
  echo "$PREVIEW_REPOSITORY の確認環境を停止しています..."
  if stop_preview "確認環境の停止"; then
    echo "停止しました。"
    exit 0
  fi
  exit 1
fi

# --- 起動 ---------------------------------------------------------------------
TARGET="${TARGET:-$DEFAULT_REPOSITORY}"
resolve_target "$TARGET"

# 既に何かが動いていれば先に止める。**同じリポジトリでもHMRに任せず必ず入れ替える。**
# developの更新には依存関係やマイグレーションの追加が混ざり、それらは起動中のプロセスへは
# 反映されない。別のリポジトリなら、そもそも同時には動かせない（先頭のコメント）。
load_state
if [[ -n "$PREVIEW_REPOSITORY" ]]; then
  if [[ "$PREVIEW_REPOSITORY" == "$TARGET" ]]; then
    echo "既に起動している $TARGET の確認環境を、最新の状態で入れ替えます。"
  else
    echo "$PREVIEW_REPOSITORY の確認環境を停止し、$TARGET へ切り替えます（同時に動かせるのは1つです）。"
  fi
  stop_preview "確認環境の切り替え" || true
fi

# #1289の頃のworktree（`<置き場>/develop`）が残っていれば片付ける。同じポートを掴んだままだと
# 新しい確認環境が`EADDRINUSE`で起動できない。**未コミットの変更があれば`git worktree remove`が
# 断るので、黙って捨てることにはならない。**
LEGACY_DIR="$(dirname "$WORKTREE_DIR")/develop"
if [[ -d "$LEGACY_DIR" ]]; then
  echo "旧来の develop 用worktree（$LEGACY_DIR）を片付けています..."
  dev_server_stop_by_port "$DEV_PORT" "$LEGACY_DIR" "$DEV_LOG" "確認環境への移行" || true
  rm -f "$(dirname "$DEV_PID_FILE")/develop.pid"
  git -C "$REPO_PATH" worktree remove "$LEGACY_DIR" 2>/dev/null ||
    echo "  （残っています。中身を確認して手で削除してください: $LEGACY_DIR）" >&2
fi

mkdir -p "$(dirname "$WORKTREE_DIR")" "$(dirname "$DEV_LOG")"

if [[ -e "$WORKTREE_DIR" ]]; then
  if ! git -C "$WORKTREE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: $WORKTREE_DIR はgitの作業ツリーではありません。中身を確認して削除してください。" >&2
    exit 1
  fi
  # ここは「developを見るための場所」であって作業場所ではない。ブランチが乗っている・
  # 未コミットの変更があるということは、想定外の使い方をされている。**黙って捨てない。**
  current_branch="$(git -C "$WORKTREE_DIR" branch --show-current)"
  if [[ -n "$current_branch" ]]; then
    echo "Error: $WORKTREE_DIR がブランチ $current_branch を開いています（このworktreeはdetached HEADで使います）。" >&2
    echo "       意図しない状態なので、中身を確認してから git -C \"$WORKTREE_DIR\" checkout --detach してください。" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$WORKTREE_DIR" status --porcelain)" ]]; then
    echo "Error: $WORKTREE_DIR に未コミットの変更があります。developを映すための場所なので、ここでは作業しないでください。" >&2
    echo "       内容を確認し、不要なら git -C \"$WORKTREE_DIR\" checkout . で捨ててから再実行してください。" >&2
    exit 1
  fi
fi

if [[ "$UPDATE" -eq 1 ]]; then
  if ! BASE_BRANCH="$(resolve_base_branch)"; then
    echo "Error: $TARGET のベースブランチを判定できませんでした（origin/HEAD が引けません）。" >&2
    exit 1
  fi
  echo "origin/$BASE_BRANCH を取得しています..."
  git -C "$REPO_PATH" fetch origin "$BASE_BRANCH"
  TARGET_SHA="$(git -C "$REPO_PATH" rev-parse "origin/$BASE_BRANCH")"
  if [[ ! -e "$WORKTREE_DIR" ]]; then
    echo "確認環境用のworktreeを作成しています（$WORKTREE_DIR）..."
    git -C "$REPO_PATH" worktree add --detach "$WORKTREE_DIR" "$TARGET_SHA"
  else
    git -C "$WORKTREE_DIR" checkout --quiet --detach "$TARGET_SHA"
  fi
elif [[ ! -e "$WORKTREE_DIR" ]]; then
  echo "Error: $WORKTREE_DIR がまだありません。--no-update を外して実行してください。" >&2
  exit 1
else
  BASE_BRANCH="$(resolve_base_branch || true)"
fi

echo "対象のコミット: $(head_summary)"

# 本体の .env.local / .env を元にする（DB・認証・GitHub Appの設定はIssueごとのworktreeと同じ
# ものを使う）。既にある場合は尊重し、不足しているキーだけを補う（#1099）。
supply_env_files "preview" "$REPO_PATH" "$WORKTREE_DIR" .env.local .env

for env_name in .env.local .env; do
  if [[ -f "$WORKTREE_DIR/$env_name" ]]; then
    bash "$SCRIPT_DIR/update-env-file.sh" "$WORKTREE_DIR/$env_name" PORT "$DEV_PORT"
    # **書き込み系APIを塞いだまま動かす**（#2444）。確認環境が動かすのは「まだ本番へ出して
    # いないコード」で、そこから実データのGitHubリポジトリ・外部サービスへ書けてしまうと、
    # 確かめるつもりの操作が本番の変更になる。`PREVIEW_MODE`はまさにその形を防ぐためのガード
    # （src/lib/preview-mode.ts）で、本体の`.env.local`からコピーされる値に任せず**ここで必ず
    # 立て直す**（本体側で外した状態がそのまま確認環境へ伝播しないようにする）。
    #
    # このキーを知らないリポジトリでは未使用の環境変数が1つ増えるだけで、挙動は変わらない。
    bash "$SCRIPT_DIR/update-env-file.sh" "$WORKTREE_DIR/$env_name" PREVIEW_MODE "true"
  fi
done

PACKAGE_MANAGER="$(detect_package_manager "$WORKTREE_DIR" || echo npm)"
echo "$PACKAGE_MANAGER install しています..."
(cd "$WORKTREE_DIR" && "$PACKAGE_MANAGER" install)

# DBは本体・各Issueのworktreeと共有しているため、マージ済みのマイグレーションが未適用だと
# 画面がエラーになる。**適用先はこのローカルの開発用DBだけ**（.env.localのDATABASE_URL）。
# 適用済みのマイグレーションは何もしないので、毎回叩いても増えていかない。
# **Prismaを使わないリポジトリでは何もしない。**
if [[ "$MIGRATE" -eq 1 && -d "$WORKTREE_DIR/prisma/migrations" ]]; then
  echo "マイグレーションを適用しています（prisma migrate deploy）..."
  # **パッケージマネージャの`exec`を経由しない。** `npm exec`は`--`を挟まないと引数を
  # 自分のものとして解釈するため、pnpmと同じ書き方では通らない。node_modulesの中の実体を
  # 直接叩けば、どのパッケージマネージャでも同じ1行で済む。
  if ! (cd "$WORKTREE_DIR" && ./node_modules/.bin/prisma migrate deploy); then
    # 起動そのものは止めない。画面が出れば「何が起きているか」をログと画面から追える。
    #
    # **失敗は`_prisma_migrations`に記録され、解消するまで以降のマイグレーションが一切当たらない。**
    # 同じ開発用DBを本体・全worktreeで共有しているため、放置すると他のセッションの画面確認まで
    # 巻き込む。典型的な原因は、Issueのworktreeで`prisma migrate dev`を叩いて先に列を足しており、
    # developへマージされた側のマイグレーション名と食い違っていること（実際に#1289で発生した）。
    echo "警告: マイグレーションの適用に失敗しました。画面がDBエラーになる場合はこれが原因です。" >&2
    echo "      失敗の記録が残っている間は以降のマイグレーションも当たりません（この開発用DBは全worktreeで共有）。" >&2
    echo "      復旧の手順は docs/multi-agent/local-quick-start.md「developの状態を確認環境で見る」を参照してください。" >&2
  fi
fi

# 待ち受けを`127.0.0.1`へ閉じる（#1329・#1526）。issue-deckの`scripts/dev.sh`はこの環境変数を
# 見る。**見ない他リポジトリでは待ち受けはそのリポジトリの既定のまま**で、Issueごとの
# セッション（run-issue-session.sh）と同じく「devサーバー → serve」の順で張る。
export ISSUE_DECK_DEV_HOST="${ISSUE_DECK_DEV_HOST:-127.0.0.1}"

# **ポートは環境変数で渡す（#2464）。** 上のenvファイルへの書き込みは`.env.local` / `.env`が
# **既にある**ときしか動かない。`supply_env_files`は本体チェックアウトに無ければ何もしないので、
# envファイルを使わないリポジトリ（dayspan・clip-hive・portfolio など）ではPORTがどこにも
# 書かれず、リポジトリ側の既定（`PORT=${PORT:-3000}`）に落ちていた。状態ファイルと画面だけが
# 6000を指し続け、利用者からは原因が全く見えない状態になる。
#
# envファイルへの書き込みは残す（手で`pnpm dev`を叩き直す経路のため）。envファイルを持つ
# リポジトリではそちらが勝つ（`scripts/dev.sh`が`set -a; source .env.local`で読む）が、
# 書いてある値は同じポートなので結果は変わらない。
export PORT="$DEV_PORT"

PREVIEW_REPOSITORY="$TARGET"
PREVIEW_WORKTREE="$WORKTREE_DIR"
PREVIEW_PORT="$DEV_PORT"
PREVIEW_BRANCH="${BASE_BRANCH:-}"
PREVIEW_COMMIT="$(git -C "$WORKTREE_DIR" log -1 --format='%h' 2>/dev/null || true)"
PREVIEW_SUBJECT="$(git -C "$WORKTREE_DIR" log -1 --format='%s' 2>/dev/null || true)"
PREVIEW_STARTED_AT="$(date --iso-8601=seconds)"
PREVIEW_LOG="$DEV_LOG"
PREVIEW_PID_FILE="$DEV_PID_FILE"

if [[ "$FOREGROUND" -eq 1 ]]; then
  echo "$TARGET の確認環境をこの端末で起動します（Ctrl-Cで停止）。"
  # **`exec`しない（#1526）。** tailnetへの公開を終了時に撤去する必要があり、`exec`でシェルを
  # 置き換えるとtrapが残らない。Ctrl-Cはフォアグラウンドのプロセスグループ全体へ届くので、
  # 開発サーバーはこれまでどおり止まる。
  trap 'tailscale_serve_unpublish "$DEV_PORT"; clear_state' EXIT INT TERM
  PREVIEW_URL="$(tailscale_serve_publish "$DEV_PORT" || true)"
  save_state
  echo "アクセスURL:"
  print_urls "$DEV_PORT" "$PREVIEW_URL"
  cd "$WORKTREE_DIR"
  $DEV_COMMAND
  exit $?
fi

echo "$TARGET の確認環境をポート $DEV_PORT でバックグラウンド起動しています（ログ: $DEV_LOG）..."
dev_server_log_event "$DEV_LOG" "$TARGET の確認環境を起動します（$(head_summary)・ポート $DEV_PORT）。"
(
  cd "$WORKTREE_DIR"
  # `set -m` でジョブに独自のプロセスグループを持たせる（PGID == PID）。停止時に
  # プロセスグループごと撃てるようにするためで、lib/dev-server.sh の判定もこれを前提にする。
  # `nohup` はSSHを切っても落ちないようにするため。stdinを/dev/nullにするのは、バックグラウンドの
  # プロセスグループが端末から読もうとしてSIGTTINで止まるのを防ぐため（#1094）。
  # リダイレクトを`>>`（O_APPEND）で開くのは、停止理由の行と競合させないため（#1679）。
  set -m
  nohup $DEV_COMMAND </dev/null >>"$DEV_LOG" 2>&1 &
  echo "$!" >"$DEV_PID_FILE"
)

# 起動直後に落ちる（ポートの衝突・.env.localの不備など）ことがある。すぐ死んだ場合に
# 「起動しました」とだけ出すと、URLを開いて初めて気づくことになる。
sleep 2
if [[ -z "$(preview_running)" ]]; then
  echo "Error: 確認環境が起動直後に終了しました。ログの末尾を確認してください: $DEV_LOG" >&2
  tail -n 20 "$DEV_LOG" >&2 || true
  rm -f "$DEV_PID_FILE"
  clear_state
  exit 1
fi

# **指定したポートを本当に掴んだかを確かめる（#2464）。** 対象リポジトリの`dev`スクリプトが
# `PORT`（環境変数・envファイルのどちらも）を見ない場合、プロセスは生きているのに待ち受けは
# 別のポートになる。ここを見ずに先へ進むと、状態ファイル・issue-deckの画面・tailnetのURLの
# すべてが**誰も居ないポート**を指したまま残り、「起動しました」と言われた側からは原因に
# 辿り着けない（#2464で実際にそうなった）。
#
# **黙って実際のポートへ合わせない。** そのポートは他リポジトリの帯と衝突しうるうえ、
# 対象リポジトリ側の直すべき不備が見えなくなる。止めて理由を出す。
if ! dev_server_wait_for_port "$DEV_PORT" "$WORKTREE_DIR" 30 "$(cat "$DEV_PID_FILE" 2>/dev/null || true)"; then
  ACTUAL_PORTS="$(dev_server_listening_ports_for_worktree "$WORKTREE_DIR" | tr '\n' ' ')"
  ACTUAL_PORTS="${ACTUAL_PORTS% }"
  if [[ -n "$ACTUAL_PORTS" ]]; then
    MESSAGE="確認環境がポート $DEV_PORT ではなく $ACTUAL_PORTS で待ち受けています。$TARGET の dev スクリプトが環境変数 PORT を見ていません。"
  else
    MESSAGE="確認環境がポート $DEV_PORT を掴めませんでした（待ち受けが1つも見つかりません）。"
  fi
  echo "Error: $MESSAGE" >&2
  echo "       案内するURLと実際の待ち受けが食い違うため、起動を取り消します。ログ: $DEV_LOG" >&2
  dev_server_log_event "$DEV_LOG" "$MESSAGE 起動を取り消します。"
  tail -n 20 "$DEV_LOG" >&2 || true
  save_state
  stop_preview "ポートの不一致による起動の取り消し" || true
  exit 1
fi

# tailnetへ出す（#1526）。issue-deckでは待ち受けが`127.0.0.1`に閉じているので起動を確かめてから、
# 他リポジトリでは既定の待ち受けのまま「devサーバー → serve」の順で張る。
PREVIEW_URL="$(tailscale_serve_publish "$DEV_PORT" || true)"
save_state

echo
echo "起動しました（PID $(preview_running)）。アクセスURL:"
print_urls "$DEV_PORT" "$PREVIEW_URL"
echo
echo "  状態の確認: scripts/start-preview-dev.sh --status"
echo "  停止:       scripts/start-preview-dev.sh --stop"
echo "  ログ:       tail -f $DEV_LOG"
