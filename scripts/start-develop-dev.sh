#!/usr/bin/env bash
# developブランチの最新状態を、そのまま開ける開発サーバーとして立てる（#1289）。
#
# Issueごとの開発サーバー（scripts/start-issue.sh・run-issue-session.sh）は「実装中のブランチ」を
# 映すもので、**マージ済みの変更が積み上がったdevelopそのものを見る場所がなかった**。本体
# チェックアウト（~/apps/issue-deck）で`pnpm dev`を叩くのは、そのときのブランチ・未コミットの
# 変更・ポートのどれもが手元の作業次第で変わるうえ、後始末の仕組み（PIDファイル・ログ）にも
# 載らないため、developを見る用途には使えない。
#
# 使い方:
#   scripts/start-develop-dev.sh              最新のorigin/developへ更新して（再）起動する
#   scripts/start-develop-dev.sh --status     起動しているか・どのコミットかとURLを表示する
#   scripts/start-develop-dev.sh --stop       停止する
#   scripts/start-develop-dev.sh --no-update  今チェックアウトされている内容のまま再起動する
#   scripts/start-develop-dev.sh --no-migrate マイグレーションの適用（prisma migrate deploy）を行わない
#   scripts/start-develop-dev.sh --foreground この端末で動かす（Ctrl-Cで停止・ログは端末に出る）
#
# 既定はバックグラウンド起動。**Tailscale SSHで入って叩き、SSHを切ってもそのまま残る**
# （`nohup`でSIGHUPを無視する）。tailnet内の端末からは
# `http://<MagicDNSの名前>:<ポート>` で開ける。`next dev`は既定で全インターフェース
# （IPv4/IPv6の両方）を待ち受けるため、待ち受けアドレスの指定は不要
# （docs/multi-agent/local-quick-start.md「Tailscale経由でスマホから画面を見る」）。
#
# 環境変数:
#   ISSUE_DECK_WORKTREE_BASE      worktreeの置き場（既定: ~/apps/issue-deck-worktrees）
#   ISSUE_DECK_DEVELOP_DEV_PORT   使うポート（既定: 下記のベース値+0 = 4000）
#   ISSUE_DECK_DEV_PORT_BASE      ポートのベース値（既定: issue-deckの帯 = 4000）
#
# **Issueごとのworktreeとは別のディレクトリ（`<置き場>/develop`）に、detached HEADで置く。**
# 同じブランチを2つの作業ツリーで開くことはgitが許さず（本体が`develop`を開いている）、
# detachedにしておけばここで誤ってコミットしても`develop`は動かない。ディレクトリ名が
# `issue-*`に一致しないため、scripts/cleanup-worktrees.sh と scripts/reap-dev-servers.sh の
# 対象にもならない（**意図的に常駐させる開発サーバー**であり、アイドルでの自動回収はしない。
# 止めるときは `--stop`）。
#
# 前提:
#   - 本体チェックアウトに `.env.local` があること（ここへコピー・不足キーの追記を行う）
#   - ローカルのMySQLが起動していること（DBは本体・各Issueのworktreeと共有する）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 開発サーバーの止め方・PIDの持ち主判定は、Issueごとのセッション（run-issue-session.sh）・
# 回収スクリプト（reap-dev-servers.sh）と共有する。**止め方を増やさない**（#1223）。
# shellcheck source=scripts/lib/dev-server.sh
source "$SCRIPT_DIR/lib/dev-server.sh"
# 本体の .env.local からworktreeへ環境変数を供給する処理も、ランチャー群と共有する（#1099）。
# shellcheck source=scripts/lib/env-file-sync.sh
source "$SCRIPT_DIR/lib/env-file-sync.sh"

# 本体チェックアウト（`git worktree add`を実行する側）。**このスクリプト自身の位置からは
# 決めない。** developのworktreeの中から叩かれることがあり、その場合 `$SCRIPT_DIR/..` は
# 本体ではなくworktree自身を指す。共有の`.git`（--git-common-dir）から本体をたどる。
GIT_COMMON_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -z "$GIT_COMMON_DIR" ]]; then
  echo "Error: $SCRIPT_DIR/.. はgitリポジトリではありません。" >&2
  exit 1
fi
ROOT="$(dirname "$GIT_COMMON_DIR")"

WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
WORKTREE_DIR="$WORKTREE_BASE/develop"
DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"
DEV_LOG="$DEV_SERVER_DIR/develop.log"
DEV_PID_FILE="$DEV_SERVER_DIR/develop.pid"

# Issue番号は1以上なので、帯のベース値そのもの（+0）はどのIssueのworktreeとも衝突しない。
# 帯の一覧は scripts/local-repo-ports.conf を参照。
DEV_PORT="${ISSUE_DECK_DEVELOP_DEV_PORT:-$(( ${ISSUE_DECK_DEV_PORT_BASE:-4000} + 0 ))}"
DEV_COMMAND="${ISSUE_DECK_DEV_COMMAND:-pnpm dev}"

MODE=start
UPDATE=1
MIGRATE=1
FOREGROUND=0

for arg in "$@"; do
  case "$arg" in
    --status) MODE=status ;;
    --stop) MODE=stop ;;
    --no-update) UPDATE=0 ;;
    --no-migrate) MIGRATE=0 ;;
    --foreground) FOREGROUND=1 ;;
    *)
      echo "Usage: scripts/start-develop-dev.sh [--status|--stop] [--no-update] [--no-migrate] [--foreground]" >&2
      exit 1
      ;;
  esac
done

# 動いている開発サーバーのPIDを返す（無ければ空）。**PIDファイルの中身をそのまま信じない。**
# 後始末が通らずに残ったPIDファイルが、再利用された無関係なPIDを指していることがある（#1223）。
running_pid() {
  local pid
  [[ -f "$DEV_PID_FILE" ]] || return 0
  pid="$(cat "$DEV_PID_FILE" 2>/dev/null || true)"
  if dev_server_pid_matches "$pid" "$WORKTREE_DIR"; then
    printf '%s' "$pid"
  fi
}

# tailnet内の他の端末（スマホ・メインPC）から開けるURLを表示する。
# Tailscaleが無い・落ちている環境でも起動そのものは妨げない。
print_urls() {
  echo "  http://localhost:$DEV_PORT"
  command -v tailscale >/dev/null 2>&1 || return 0
  local status_json
  status_json="$(tailscale status --json 2>/dev/null || true)"
  [[ -n "$status_json" ]] || return 0
  local host_names
  host_names="$(printf '%s' "$status_json" | python3 -c '
import json
import sys

try:
    self_node = json.load(sys.stdin).get("Self") or {}
except Exception:
    sys.exit(0)

# MagicDNSの名前（末尾のドットは落とす）とtailnet IPの両方を出す。MagicDNSが無効な
# tailnetでもIPなら開けるため、片方だけに寄せない。開いたときの制約が違うので種別も添える。
lines = []
dns_name = (self_node.get("DNSName") or "").rstrip(".")
if dns_name:
    lines.append("dns\t" + dns_name)
lines.extend("ip\t" + ip for ip in (self_node.get("TailscaleIPs") or []))
print("\n".join(lines))
' 2>/dev/null || true)"
  local kind name
  while IFS=$'\t' read -r kind name; do
    [[ -n "$name" ]] || continue
    local url="http://$name:$DEV_PORT"
    # IPv6は角括弧で囲まないとURLとして開けない。
    [[ "$name" == *:* ]] && url="http://[$name]:$DEV_PORT"
    if [[ "$kind" == "dns" ]]; then
      echo "  $url  （tailnet内の端末からはこのURLを使う）"
    else
      # 生のtailnet IPは next.config.ts の allowedDevOrigins（`**.ts.net`）に当たらないため、
      # 画面のHTMLは出ても `/_next/*` が403になる（実測）。MagicDNSが使えないときの逃げ道。
      echo "  $url  （MagicDNSが使えない場合のみ。.env.localのISSUE_DECK_DEV_ALLOWED_ORIGINSに足さないと/_next/*が403になる）"
    fi
  done <<<"$host_names"
}

# 今チェックアウトしているコミットを1行で表す。どの時点のdevelopを見ているのかが、
# 画面を見ている最中にも確かめられるようにする。
head_summary() {
  git -C "$WORKTREE_DIR" log -1 --format='%h %s' 2>/dev/null || echo "(不明)"
}

stop_server() {
  local pid
  pid="$(running_pid)"
  if [[ -z "$pid" ]]; then
    # 生きてはいるが別人のPIDファイルは消すだけにする（プロセスグループごと撃つ処理なので、
    # 確信が持てない相手には触らない）。
    rm -f "$DEV_PID_FILE"
    return 1
  fi
  dev_server_log_event "$DEV_LOG" "develop用の開発サーバー（プロセスグループ $pid）を停止します。再び見るときは scripts/start-develop-dev.sh で起こしてください。"
  echo "develop用の開発サーバー（PID $pid）を停止しています..."
  if ! dev_server_stop_group "$pid"; then
    echo "Error: 開発サーバー（PID $pid）を停止できませんでした。手動で確認してください。" >&2
    return 2
  fi
  rm -f "$DEV_PID_FILE"
  echo "停止しました。"
  return 0
}

case "$MODE" in
  status)
    pid="$(running_pid)"
    if [[ -n "$pid" ]]; then
      echo "develop用の開発サーバー: 起動中（PID $pid・ポート $DEV_PORT）"
    else
      echo "develop用の開発サーバー: 停止中（ポート $DEV_PORT）"
    fi
    if [[ -d "$WORKTREE_DIR" ]]; then
      echo "  worktree: $WORKTREE_DIR"
      echo "  HEAD: $(head_summary)"
    else
      echo "  worktree: 未作成（$WORKTREE_DIR）"
    fi
    echo "  ログ: $DEV_LOG"
    if [[ -n "$pid" ]]; then
      print_urls
    fi
    exit 0
    ;;
  stop)
    set +e
    stop_server
    stop_status=$?
    set -e
    case "$stop_status" in
      0) exit 0 ;;
      1) echo "develop用の開発サーバーは起動していません。" ; exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
esac

mkdir -p "$WORKTREE_BASE" "$DEV_SERVER_DIR"

# 既に動いていれば先に止める。**HMRに任せず必ず入れ替える。** developの更新には
# 依存関係やマイグレーションの追加が混ざり、それらは起動中のプロセスへは反映されない。
if [[ -n "$(running_pid)" ]]; then
  echo "既に起動しているdevelop用の開発サーバーを、最新のdevelopで入れ替えます。"
  stop_server || true
fi

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
  echo "origin/develop を取得しています..."
  git -C "$ROOT" fetch origin develop
  DEVELOP_SHA="$(git -C "$ROOT" rev-parse origin/develop)"
  if [[ ! -e "$WORKTREE_DIR" ]]; then
    echo "develop用のworktreeを作成しています（$WORKTREE_DIR）..."
    git -C "$ROOT" worktree add --detach "$WORKTREE_DIR" "$DEVELOP_SHA"
  else
    git -C "$WORKTREE_DIR" checkout --quiet --detach "$DEVELOP_SHA"
  fi
elif [[ ! -e "$WORKTREE_DIR" ]]; then
  echo "Error: $WORKTREE_DIR がまだありません。--no-update を外して実行してください。" >&2
  exit 1
fi

echo "対象のコミット: $(head_summary)"

# 本体の .env.local を元にする（DB・認証・GitHub Appの設定はIssueごとのworktreeと同じものを使う）。
# 既にある場合は尊重し、不足しているキーだけを補う（#1099）。
if [[ ! -f "$WORKTREE_DIR/.env.local" ]]; then
  if [[ -f "$ROOT/.env.local" ]]; then
    cp "$ROOT/.env.local" "$WORKTREE_DIR/.env.local"
    echo ".env.local を本体からコピーしました。"
  else
    echo "警告: $ROOT/.env.local が無いため .env.local をコピーしませんでした。" >&2
  fi
elif [[ -f "$ROOT/.env.local" ]]; then
  sync_missing_env_keys "develop" "$ROOT/.env.local" "$WORKTREE_DIR/.env.local"
fi

if [[ -f "$WORKTREE_DIR/.env.local" ]]; then
  bash "$ROOT/scripts/update-env-file.sh" "$WORKTREE_DIR/.env.local" PORT "$DEV_PORT"
fi

echo "pnpm install しています..."
(cd "$WORKTREE_DIR" && pnpm install)

# DBは本体・各Issueのworktreeと共有しているため、developへマージ済みのマイグレーションが
# 未適用だと画面がエラーになる。**適用先はこのローカルの開発用DBだけ**（.env.localの
# DATABASE_URL）。適用済みのマイグレーションは何もしないので、毎回叩いても増えていかない。
if [[ "$MIGRATE" -eq 1 ]]; then
  echo "マイグレーションを適用しています（prisma migrate deploy）..."
  if ! (cd "$WORKTREE_DIR" && pnpm exec prisma migrate deploy); then
    # 起動そのものは止めない。画面が出れば「何が起きているか」をログと画面から追える。
    #
    # **失敗は`_prisma_migrations`に記録され、解消するまで以降のマイグレーションが一切当たらない。**
    # 同じ開発用DBを本体・全worktreeで共有しているため、放置すると他のセッションの画面確認まで
    # 巻き込む。典型的な原因は、Issueのworktreeで`prisma migrate dev`を叩いて先に列を足しており、
    # developへマージされた側のマイグレーション名と食い違っていること（実際に#1289で発生した）。
    echo "警告: マイグレーションの適用に失敗しました。画面がDBエラーになる場合はこれが原因です。" >&2
    echo "      失敗の記録が残っている間は以降のマイグレーションも当たりません（この開発用DBは全worktreeで共有）。" >&2
    echo "      復旧の手順は docs/multi-agent/local-quick-start.md「developの状態を開発サーバーで見る」を参照してください。" >&2
  fi
fi

if [[ "$FOREGROUND" -eq 1 ]]; then
  echo "develop用の開発サーバーをこの端末で起動します（Ctrl-Cで停止）。"
  echo "アクセスURL:"
  print_urls
  cd "$WORKTREE_DIR"
  exec $DEV_COMMAND
fi

echo "develop用の開発サーバーをポート $DEV_PORT でバックグラウンド起動しています（ログ: $DEV_LOG）..."
dev_server_log_event "$DEV_LOG" "develop用の開発サーバーを起動します（$(head_summary)・ポート $DEV_PORT）。"
(
  cd "$WORKTREE_DIR"
  # `set -m` でジョブに独自のプロセスグループを持たせる（PGID == PID）。停止時に
  # プロセスグループごと撃てるようにするためで、lib/dev-server.sh の判定もこれを前提にする。
  # `nohup` はSSHを切っても落ちないようにするため。stdinを/dev/nullにするのは、バックグラウンドの
  # プロセスグループが端末から読もうとしてSIGTTINで止まるのを防ぐため（#1094）。
  set -m
  nohup $DEV_COMMAND </dev/null >>"$DEV_LOG" 2>&1 &
  echo "$!" >"$DEV_PID_FILE"
)

# 起動直後に落ちる（ポートの衝突・.env.localの不備など）ことがある。すぐ死んだ場合に
# 「起動しました」とだけ出すと、URLを開いて初めて気づくことになる。
sleep 2
if [[ -z "$(running_pid)" ]]; then
  echo "Error: 開発サーバーが起動直後に終了しました。ログの末尾を確認してください: $DEV_LOG" >&2
  tail -n 20 "$DEV_LOG" >&2 || true
  rm -f "$DEV_PID_FILE"
  exit 1
fi

echo
echo "起動しました（PID $(running_pid)）。アクセスURL:"
print_urls
echo
echo "  状態の確認: scripts/start-develop-dev.sh --status"
echo "  停止:       scripts/start-develop-dev.sh --stop"
echo "  ログ:       tail -f $DEV_LOG"
