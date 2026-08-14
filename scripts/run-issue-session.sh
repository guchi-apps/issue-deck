#!/usr/bin/env bash
# Issue専用worktreeの開発サーバー（pnpm dev）をバックグラウンドで自動起動したうえで、
# Claude Codeセッションをフォアグラウンドで実行するラッパー。
# セッション終了時（正常終了・ターミナルclose・kill等）にtrapで開発サーバーも自動停止する。
# trapを通れない経路（SIGKILL・ホストの再起動）で残った分は、scripts/reap-dev-servers.sh が
# 別途回収する（#1223）。**このtrapが唯一の後始末ではない。**
#
# 使い方:
#   scripts/run-issue-session.sh <issue番号> <devポート> <プロンプトファイルパス>
#
# 呼び出し元（start-issue.sh・generic-start-issue.sh）が事前に対象worktreeディレクトリへ
# cdしている前提で、カレントディレクトリを基準に開発サーバーを起動する。
#
# 環境変数:
#   ISSUE_DECK_DEV_SERVER=0    開発サーバーを起動しない（既定は起動する）
#   ISSUE_DECK_DEV_COMMAND     開発サーバーの起動コマンド（既定は `pnpm dev`）
#
# **汎用ランチャー経由（#1224）では既定で起動しない。** サブPCは2C/4Tで、リポジトリ数ぶんの
# devサーバーを常駐させる前提が置けない（#1177の実測）。必要なセッションだけ中で起動する。
#
# セッションには `--name "<リポジトリ名> #<Issue番号>"` を付ける。Claude Codeはこの名前を
# ターミナルのタイトル（OSC 0）にも出すため、タブを複数開いてもどのリポジトリのどのIssueを
# 見ているかが分かる（#1105）。付けない場合は会話内容から自動命名された名前が出るため、
# タブからIssueを特定できない。
#
# セッションへ最初に渡すプロンプトは、プロンプトファイルの中身そのものではなく「そのファイルを
# 読んで着手せよ」という1行にする（#1105）。届かなかった場合に1行を貼り直すだけで復帰できる。

set -euo pipefail
set -m

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/run-issue-session.sh <issue番号> <devポート> <プロンプトファイルパス>" >&2
  exit 1
fi

ISSUE_NUMBER="$1"
DEV_PORT="$2"
PROMPT_FILE="$3"

# フック用スクリプトをこのファイルからの相対で解決する。呼び出し元がworktreeへcdしている前提の
# スクリプトなので、カレントディレクトリ基準では自分のscripts/を指せない。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 開発サーバーの止め方は回収スクリプト（scripts/reap-dev-servers.sh）と共有する（#1223）。
# shellcheck source=scripts/lib/dev-server.sh
source "$SCRIPT_DIR/lib/dev-server.sh"
# セッションの状態ファイル（#1256）。回収スクリプト（scripts/reap-sessions.sh）と共有する。
# shellcheck source=scripts/lib/session-state.sh
source "$SCRIPT_DIR/lib/session-state.sh"
# 開発サーバーをtailnetへ出す（#1265）。回収スクリプトと共有する。
# shellcheck source=scripts/lib/tailscale-serve.sh
source "$SCRIPT_DIR/lib/tailscale-serve.sh"
# セッションの出力言語（#1395）。レビューセッション（scripts/start-reviewer.sh）と共有する。
# shellcheck source=scripts/lib/agent-language.sh
source "$SCRIPT_DIR/lib/agent-language.sh"
# 本体の作業ツリーの scripts/ が古いままになっていないかの警告（#1274）。
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$SCRIPT_DIR/lib/launcher-scripts-sync.sh"

# start-issue.sh・generic-start-issue.sh も同じ警告を出しているが、そちらは呼び出し元プロセスの
# 標準出力に出るだけで、tmux経由（`tmux new-session -d`）で起動した場合はそのまま誰にも見られずに
# 消える。新しいtmuxのpaneは呼び出し元とは別のptyで、直後にこのスクリプトの出力だけが流れ込む
# ため、呼び出し元の警告を引き継がない。サブPCのpollerが起動する経路（無人）ではなおさら、
# 呼び出し元の標準出力はjournalctlにしか残らずtmuxをattachしたユーザーからは見えない。ここでも
# 同じ警告を出し、実際にユーザーが見る画面（tmuxのpane）に確実に載せる（#1426）。
ISSUE_DECK_ROOT="$(dirname "$SCRIPT_DIR")"
warn_launcher_scripts_stale "$ISSUE_DECK_ROOT"

# tmuxのセッション名。セッションの状態ファイルのキーになる（#1256）。
# **tmuxの外で起動した場合は空。** そのときは状態ファイルを書かず、自動回収の対象にもしない
# （回収は`tmux kill-session`で行うため、tmuxの外のセッションには手が届かない）。
TMUX_SESSION_NAME=""
if [[ -n "${TMUX:-}" ]]; then
  TMUX_SESSION_NAME="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi

WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"
DEV_LOG="$DEV_SERVER_DIR/issue-$ISSUE_NUMBER.log"
DEV_PID_FILE="$DEV_SERVER_DIR/issue-$ISSUE_NUMBER.pid"

DEV_SERVER_ENABLED="${ISSUE_DECK_DEV_SERVER:-1}"
DEV_COMMAND="${ISSUE_DECK_DEV_COMMAND:-pnpm dev}"

mkdir -p "$DEV_SERVER_DIR"

# 前回のセッションがタブの強制終了などでtrapを通らずに終わると、開発サーバーが残ったまま
# ポートを掴んでいることがある。再開時（#1076）にpnpm devが起動できなくなるため先に止める。
#
# **PIDファイルのPIDが再利用されている場合は触らない**（#1223）。ここはプロセスグループごと
# killする箇所なので、PIDファイルが指す相手が本当にこのworktreeの開発サーバーかを確かめる。
if [[ -f "$DEV_PID_FILE" ]]; then
  STALE_PID="$(cat "$DEV_PID_FILE" 2>/dev/null || true)"
  if dev_server_pid_matches "$STALE_PID" "$PWD"; then
    echo "#$ISSUE_NUMBER: 前回の開発サーバー（PID $STALE_PID）が残っているため停止します..."
    dev_server_log_event "$DEV_LOG" "セッションの再開に伴い、前回の開発サーバー（PID $STALE_PID）を停止します。"
    dev_server_stop_group "$STALE_PID" ||
      echo "警告: #$ISSUE_NUMBER: 前回の開発サーバー（PID $STALE_PID）を停止できませんでした。ポート $DEV_PORT が空かないかもしれません。" >&2
  elif [[ -n "$STALE_PID" ]] && kill -0 "$STALE_PID" 2>/dev/null; then
    # 生きてはいるが別人。無関係なプロセスグループを撃つほうが危ないので触らない。
    echo "#$ISSUE_NUMBER: 情報: PIDファイルのPID（$STALE_PID）はこのworktreeの開発サーバーではないため、停止しません。" >&2
  fi
  rm -f "$DEV_PID_FILE"
fi

DEV_PGID=""
PREVIEW_URL=""

# issue-deckへ報告するための設定値を1つ読む。**環境変数が優先で、無ければ`dispatch.env`。**
# pollerは`set -a`付きでこのファイルをsourceしてから起動するため、poller経由のセッションでは
# 環境変数側に載っている。手元のターミナルから直接起動した場合はファイルから読む。
# 見つからなければ空を返し、呼び出し側が「報告しない」を選ぶ。
dispatch_env_value() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
    return 0
  fi
  local env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
  [[ -f "$env_file" ]] || return 0
  # shellcheck disable=SC1090
  (source "$env_file" >/dev/null 2>&1; printf '%s' "${!name:-}")
}

# issue-deckへ報告するときの`owner/repo`。remoteのURLから導く（取れなければ空を返し、
# 呼び出し側が「報告しない」を選ぶ）。
current_repo_slug() {
  git config --get remote.origin.url 2>/dev/null |
    sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' || true
}

# 報告に載せるホスト名。**pollerの決め方（`DISPATCH_HOST_NAME`→`hostname -s`）と揃える。**
# ずれると照合が外れて黙って0件になる。
dispatch_host_name() {
  local host_name
  host_name="$(dispatch_env_value DISPATCH_HOST_NAME)"
  [[ -n "$host_name" ]] || host_name="$(hostname -s 2>/dev/null || true)"
  printf '%s' "$host_name"
}

# 公開したURLをissue-deckの画面へ渡す（#1265）。**スマホから画面を見る唯一の出口**なので、
# ターミナルのログだけに出しても届かない。宛先と鍵はpollerと同じ`dispatch.env`から読む。
# 受け口は`session-notify.sh`と共有（`POST /api/dispatch/sessions/activity`）。
# **未設定でも失敗してもセッションは止めない。**
report_preview_url_to_issue_deck() {
  local preview_url="$1"

  local app_base_url dispatch_secret repo_slug body
  app_base_url="$(dispatch_env_value APP_BASE_URL)"
  dispatch_secret="$(dispatch_env_value DISPATCH_SECRET)"
  repo_slug="$(current_repo_slug)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" && -n "$repo_slug" ]] || return 0

  body="$(PREVIEW_URL="$preview_url" REPO_SLUG="$repo_slug" ISSUE_NUMBER="$ISSUE_NUMBER" python3 -c '
import json, os
print(json.dumps({
    "repository": os.environ["REPO_SLUG"],
    "issue": int(os.environ["ISSUE_NUMBER"]),
    "previewUrl": os.environ["PREVIEW_URL"],
}))' 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0

  curl -fsS --max-time 10 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $dispatch_secret" \
    -d "$body" \
    "${app_base_url%/}/api/dispatch/sessions/activity" >/dev/null 2>&1 ||
    echo "#$ISSUE_NUMBER: 情報: プレビューURLをissue-deckへ報告できませんでした（実装は続行します）。" >&2
}

# セッションが起動したことをIssueのコメントとして残す（#1119）。
#
# **GitHub Actionsの無人実行にはこれがある**（#75の受付コメント）。ローカルセッションには無く、
# 起動してからエージェントが最初の投稿をするまでIssueの画面には何も出ない。Actions UIに相当する
# 実行ログもサブPCには無いので、外からは「押したのに何も起きていない」と区別が付かない。
#
# **エージェントに任せず、起動スクリプトから投稿する**のもActions側と同じ理由。調査に時間が
# かかった場合や途中で行き詰まった場合に、「依頼を受け取ったこと」自体が伝わらなくなる。
#
# 投稿するのはissue-deck（GitHub App名義）で、ここは報告するだけ。**サブPCにGitHubの認証を
# 持たせない**ための一本化に倣う。tmuxの外で起動した場合はセッション名が無く、本文に載せる
# `tmux attach`の相手も無いので何もしない。
# **未設定でも失敗してもセッションは止めない。**
report_session_started_to_issue_deck() {
  [[ -n "$TMUX_SESSION_NAME" ]] || return 0

  local app_base_url dispatch_secret repo_slug host_name body
  app_base_url="$(dispatch_env_value APP_BASE_URL)"
  dispatch_secret="$(dispatch_env_value DISPATCH_SECRET)"
  repo_slug="$(current_repo_slug)"
  host_name="$(dispatch_host_name)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" && -n "$repo_slug" && -n "$host_name" ]] || return 0

  body="$(REPO_SLUG="$repo_slug" ISSUE_NUMBER="$ISSUE_NUMBER" HOST_NAME="$host_name" \
    SESSION_NAME="$TMUX_SESSION_NAME" python3 -c '
import json, os
print(json.dumps({
    "repository": os.environ["REPO_SLUG"],
    "issue": int(os.environ["ISSUE_NUMBER"]),
    "host": os.environ["HOST_NAME"],
    "tmuxSessionName": os.environ["SESSION_NAME"],
}))' 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0

  curl -fsS --max-time 10 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $dispatch_secret" \
    -d "$body" \
    "${app_base_url%/}/api/dispatch/sessions/started" >/dev/null 2>&1 ||
    echo "#$ISSUE_NUMBER: 情報: セッションの受付コメントをissue-deckへ報告できませんでした（実装は続行します）。" >&2
}

# セッションが畳まれたことをその場でissue-deckへ知らせる（#1321）。
#
# pollerも1巡ごとに全セッションを報告しているが、**そちらは実測で最大75秒遅れる**
# （`sleep`の60秒＋1巡の実処理の約14秒）。#1311で生きているセッションのあるIssueは起動を
# 押せなくしたため、その遅れがそのまま「畳んだのにまだ押せない」時間になっていた。
#
# **送るのは「このセッションは終わった」だけで、終了コードは送らない。** `tmux kill-session`では
# HUPでtrapに入るため、ここで拾える終了コードは異常終了かどうかを表さない。異常終了の判定
# （`FAILED`＝Issueコメント＋`00.check-user`の引き上げ）はpollerの担当のまま。
#
# tmuxの外で起動した場合はセッション名が無く、issue-deck側に照合する行も無いので何もしない。
# **報告できなくてもセッションの後始末は続ける**（次の巡回でpollerが拾う）。
report_session_ended_to_issue_deck() {
  [[ -n "$TMUX_SESSION_NAME" ]] || return 0

  local app_base_url dispatch_secret host_name body
  app_base_url="$(dispatch_env_value APP_BASE_URL)"
  dispatch_secret="$(dispatch_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 0

  host_name="$(dispatch_host_name)"
  [[ -n "$host_name" ]] || return 0

  body="$(HOST_NAME="$host_name" SESSION_NAME="$TMUX_SESSION_NAME" python3 -c '
import json, os
print(json.dumps({
    "host": os.environ["HOST_NAME"],
    "tmuxSessionName": os.environ["SESSION_NAME"],
}))' 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0

  # **失敗しても何も出さない。** ここが動くのはペインが壊された後で、stdout/stderrは既に無い
  # ptyを指している（#1223）。書いても誰にも届かないうえ、EIOで返る。
  # 待ち時間も短くする。届かないホストで毎回10秒待つと、そのぶんセッションの終了が伸びる。
  curl -fsS --max-time 5 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $dispatch_secret" \
    -d "$body" \
    "${app_base_url%/}/api/dispatch/sessions/ended" >/dev/null 2>&1 || true
}

cleanup() {
  # **errexitを切ってから始める（#1223）。** cleanupはtmuxのペインが破棄された後にも呼ばれ、
  # そのときのstdoutは既に無いptyを指す。書き込みはEIOで失敗し、`set -e`のままだと最初の
  # echoでcleanupごと打ち切られる。**実際にこれで`kill`にも`rm`にも到達せず、開発サーバーが
  # 孤児として残っていた**（tmuxのkill-sessionでtrapは正しく発火しており、発火しないのではなく
  # 打ち切られていた。実測の詳細はdocs/multi-agent/local-quick-start.md）。
  set +e
  # HUPで入った後、シェルの終了時にEXITでもう一度入る。停止とログを二重に行わないよう自分を外す。
  trap - EXIT HUP TERM

  if [[ -n "$DEV_PGID" ]] && dev_server_pid_matches "$DEV_PGID" "$PWD"; then
    # **記録はptyではなくログファイルへ残す。** 無人実行では「なぜ開発サーバーが落ちているのか」が
    # ここにしか残らない。stdoutへも出すが、届かなくても止めない。
    dev_server_log_event "$DEV_LOG" "セッションの終了に伴い開発サーバー（プロセスグループ $DEV_PGID）を停止します。再び画面確認が必要になったら \`cd $PWD && $DEV_COMMAND\` で起こしてください。"
    echo "#$ISSUE_NUMBER: 開発サーバー（プロセスグループ $DEV_PGID）を停止しています..."
    dev_server_stop_group "$DEV_PGID"
  fi
  rm -f "$DEV_PID_FILE"

  # tailnetへの公開（#1265）も撤去する。**セッションが落ちても設定だけ残る**ため、
  # ここで外し忘れると次に同じポートを使うセッションが古い相手へ繋がる。
  # trapを通れない経路で残った分は reap-dev-servers.sh が回収する。
  tailscale_serve_unpublish "$DEV_PORT"

  # セッションの状態ファイル（#1256）も片付ける。残すと、次に同じ名前で立ったセッションが
  # 前回の`Stop`を引き継いだように見え、起動直後に回収の条件を満たしてしまう。
  if [[ -n "$TMUX_SESSION_NAME" ]]; then
    session_state_remove "$TMUX_SESSION_NAME"
  fi

  # **画面への報告は後始末の最後に置く（#1321）。** ネットワークが死んでいるホストでは最大5秒
  # 待つため、先に置くとその間に強制終了された場合に開発サーバーが孤児として残る（#1223で
  # 実際に起きたのと同じ結果になる）。遅れるのは数秒で、消したいのは75秒のほう。
  report_session_ended_to_issue_deck
}
trap cleanup EXIT HUP TERM

if [[ "$DEV_SERVER_ENABLED" == "0" ]]; then
  echo "#$ISSUE_NUMBER: 開発サーバーは起動しません（画面確認が必要になったら worktree で \`$DEV_COMMAND\` を実行してください。ポート $DEV_PORT は env に設定済みです）。"
else
  # tailnetへ出す経路では、開発サーバーの待ち受けを`127.0.0.1`へ閉じる（#1329）。
  # `tailscale serve`は公開したポートを自ノードのtailnetアドレスで実際にlistenするため、
  # `::`を要求する`next dev`とは同じポートで両立しない。「devサーバー→serve」の順なら初回だけは
  # 成功するが、**devサーバーだけが回収（#1223）された後は`EADDRINUSE`で起こし直せない。**
  # ここで先に閉じておけば順序に依存しなくなる。
  #
  # **serveを張るのは後のまま。** 先に張ると、この変数を見ない他リポジトリの開発サーバー
  # （汎用ランチャー・#1224）が起動できなくなる。あちらは従来どおり「devサーバー→serve」の順で、
  # 待ち受けもそのリポジトリの既定のまま。
  #
  # 明示指定があればそちらを尊重する。`dev.sh`も同じ判定を単独で持つため（手で`pnpm dev`を
  # 叩き直す経路のため）、ここが渡らなくても結果は同じになる。
  if [[ -z "${ISSUE_DECK_DEV_HOST:-}" ]] && tailscale_serve_available; then
    export ISSUE_DECK_DEV_HOST="127.0.0.1"
  fi

  echo "#$ISSUE_NUMBER: 開発サーバーをポート $DEV_PORT でバックグラウンド起動しています（ログ: $DEV_LOG）..."
  # stdinを/dev/nullにするのは必須（#1094）。set -m によりこのジョブはバックグラウンドの
  # プロセスグループになるため、配下のプロセスが端末（tty）から読もうとするとカーネルが
  # SIGTTINを送り、プロセスグループごと停止（ps上は T）して誰も再開しない。
  # 実際にsetup-lan-access.shが起動するpowershell.exeがこれを踏み、devサーバーが
  # 起動しないまま止まっていた。出力はログへ逃がしていたが、stdinがttyのままだった。
  $DEV_COMMAND </dev/null >"$DEV_LOG" 2>&1 &
  DEV_PID=$!
  # set -m によりバックグラウンドジョブは新しいプロセスグループを持ち、そのPGIDは先頭プロセスのPIDと一致する。
  DEV_PGID="$DEV_PID"
  echo "$DEV_PID" >"$DEV_PID_FILE"

  # tailnetへ出す（#1265）。`tailscale serve`が`localhost:<ポート>`へプロキシする。
  # **待ち受けは上で`127.0.0.1`へ閉じてある**（#1329）。使えないホスト（メインPCのWSL等）では
  # 黙って何もしない（そのとき待ち受けも既定のままなので、tailnetからは直接見える）。
  PREVIEW_URL="$(tailscale_serve_publish "$DEV_PORT" || true)"
  if [[ -n "$PREVIEW_URL" ]]; then
    echo "#$ISSUE_NUMBER: 開発サーバーをtailnetへ公開しました: $PREVIEW_URL"
    report_preview_url_to_issue_deck "$PREVIEW_URL"
  else
    echo "#$ISSUE_NUMBER: 情報: tailnetへの公開は行いません（tailscale serveが使えないホストです）。"
  fi
fi

# 全アプリ共通の共有知識リポジトリ（guchi-apps/docs）をローカルにcloneしてある場合は、
# --add-dir でworktree外のそのディレクトリも参照できるようにする（docs/shared-knowledge.md
# 「8. Claude Codeへのコンテキストの渡し方」）。cloneしていない環境でも起動できるよう、
# 存在しない場合は --add-dir を付けずにそのまま起動する。
SHARED_CONTEXT_DIR="${ISSUE_DECK_SHARED_CONTEXT_DIR:-$HOME/apps/_docs}"
CLAUDE_EXTRA_ARGS=()
if [[ -d "$SHARED_CONTEXT_DIR" ]]; then
  CLAUDE_EXTRA_ARGS+=(--add-dir "$SHARED_CONTEXT_DIR")
  echo "#$ISSUE_NUMBER: 共有知識リポジトリを参照可能にします: $SHARED_CONTEXT_DIR"
else
  echo "#$ISSUE_NUMBER: 共有知識リポジトリ（$SHARED_CONTEXT_DIR）が見つからないため、参照なしで起動します。"
fi

# 出力言語（#1395）。個人設定（`~/.claude/CLAUDE.md`）の同期状態や対象リポジトリのCLAUDE.mdに
# 依存せず、このスクリプトから起こしたセッションの応答を日本語に揃える。文面と未対応時の扱いは
# scripts/lib/agent-language.sh を参照。
append_language_system_prompt "#$ISSUE_NUMBER: "

# セッション名（プロンプトボックス・`/resume`の一覧・ターミナルのタイトルに出る）。
# どのリポジトリのどのIssueかがタブから分かるよう「<リポジトリ名> #<Issue番号>」にする（#1105）。
REPO_NAME="$(basename -s .git "$(git config --get remote.origin.url 2>/dev/null || true)")"
if [[ -z "$REPO_NAME" || "$REPO_NAME" == "." ]]; then
  # リモート未設定でも起動は妨げない。worktreeのディレクトリ名で代用する。
  REPO_NAME="$(basename "$PWD")"
fi
SESSION_NAME="$REPO_NAME #$ISSUE_NUMBER"
# --name を解釈しない古いClaude Codeへ渡すと起動自体が失敗するため、対応時のみ付ける。
if claude --help 2>/dev/null | grep -q -- "--name"; then
  CLAUDE_EXTRA_ARGS+=(--name "$SESSION_NAME")
else
  echo "#$ISSUE_NUMBER: 情報: このClaude Codeは --name に未対応のため、タイトルにIssue番号を出しません。" >&2
fi

# 通知（#1219）用に owner/repo を取り出す。IssueのURLを組み立てるためだけに使うので、
# 取れなくても（リモート未設定・SSH形式でない等）通知からリンクが消えるだけにする。
REPO_SLUG="$(git config --get remote.origin.url 2>/dev/null | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' || true)"

# セッションの回収（#1256）用の記述子。回収スクリプトはtmuxのセッション名しか手掛かりを
# 持たないため、worktreeの場所と対応Issueをここで残しておく。
#
# **`reapable`が1のセッションだけを自動回収の対象にする。** 1を渡すのはpollerがジョブとして
# 起動した経路だけ（scripts/subpc-dispatch-poller.sh の run_job）で、手元のターミナルから
# 直接起動したセッションには渡らない。issue-deck側にジョブとして残らないセッションを
# 巻き込まないための線引きで、判定材料ではなく**起動経路そのもの**で切る。
if [[ -n "$TMUX_SESSION_NAME" ]]; then
  if ! session_state_write_descriptor "$TMUX_SESSION_NAME" "$PWD" "$REPO_SLUG" "$ISSUE_NUMBER" \
    "${ISSUE_DECK_SESSION_REAPABLE:-0}"; then
    echo "#$ISSUE_NUMBER: 情報: セッションの状態ファイルを書けなかったため、このセッションは自動回収の対象になりません（$(session_state_dir)）。" >&2
  fi
fi

# セッションの状態をSignalyへ通知するフック（#1219）、提示した計画をIssueへ残すフック（#1342）、
# 承認に答えて作業へ戻ったことをissue-deckへ伝えるフック（#1357）。
#
# **`--settings` で渡すことで、このスクリプトから起動したセッションにだけ適用する。**
# `~/.claude/settings.json` に書くとメインPCの対話セッションでも通知が飛んで邪魔になる。
# `--settings` の内容はユーザー設定・プロジェクト設定に加算される（既存の設定を壊さない）。
#
# JSON文字列ではなくファイルで渡す。`ps` の出力にフックの中身が丸ごと出るのを避けるため
# （プロンプトをファイル経由で渡しているのと同じ理由）。
# 置き場所は `.dev-servers/`・`.prompts/` と同じくworktreeの外の管理用ディレクトリ。
#
# 発火するイベントの選別（Notificationのidle_promptを捨てる等）は session-notify.sh 側が持つ。
# フック設定には「呼ぶ」ことだけを書き、判断を2箇所に分けない。
HOOKS_DIR="$WORKTREE_BASE/.claude-hooks"
HOOK_SETTINGS_FILE="$HOOKS_DIR/issue-$ISSUE_NUMBER.settings.json"
NOTIFY_SCRIPT="$SCRIPT_DIR/session-notify.sh"
if [[ -x "$NOTIFY_SCRIPT" ]]; then
  mkdir -p "$HOOKS_DIR"
  # 引数はシェルのシングルクォートで囲む。シングルクォートはJSONではただの文字なので、
  # `printf %q` のようにバックスラッシュを持ち込まずにスペースを含むパスを渡せる。
  # 値はいずれもこのスクリプトが組み立てた識別子（数字・リポジトリ名・パス）で、
  # 外部由来のテキストはここへ流さない。
  HOOK_COMMAND="'$NOTIFY_SCRIPT' '$ISSUE_NUMBER' '$REPO_NAME' '$REPO_SLUG'"
  # `PreToolUse`だけmatcherを付ける（#1342）。**計画本文（`tool_input.plan`）が手に入るのは
  # `ExitPlanMode`のこのフックだけ**で、承認プロンプトの`Notification`には入っていない。
  # matcherを付けずに全ツールで呼ぶと、`Read`・`Bash`のたびにスクリプトが起動する。
  #
  # **`PostToolUse`はmatcherを付けず全ツールで呼ぶ**（#1357）。これは「人が承認プロンプトに
  # 答えた」ことを知る唯一の手掛かりで、承認が要るツールは`Bash`・`Write`・`WebFetch`・
  # `AskUserQuestion`・MCPのツールと広く、絞ると答えたのに入力待ちのままになる組み合わせが残る。
  # 代わりに`session-notify.sh`が状態ファイルを見て「直前が入力待ちのとき」以外を即座に捨てる
  # （HTTPどころかpython3も起こさない）。
  cat >"$HOOK_SETTINGS_FILE" <<JSON
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "$HOOK_COMMAND" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "$HOOK_COMMAND" }] }
    ],
    "PreToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [{ "type": "command", "command": "$HOOK_COMMAND" }]
      }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "$HOOK_COMMAND" }] }
    ]
  }
}
JSON
  CLAUDE_EXTRA_ARGS+=(--settings "$HOOK_SETTINGS_FILE")
else
  echo "#$ISSUE_NUMBER: 情報: $NOTIFY_SCRIPT が無いため、セッションの状態通知は行いません。" >&2
fi

# Remote Control（#1219）。スマホやメインPCのブラウザから、このセッションの承認プロンプトに
# 答えたり指示を足したりできるようにする。通知（上のフック）で気づいて、ここで答える。
# 起動直後にセッションのURLが表示され、通知にも載る（session-notify.sh）。
#
# --name と同じく、解釈しない古いClaude Codeへ渡すと起動ごと失敗するため対応時のみ付ける。
# 外部から操作可能になるのを避けたいときは ISSUE_DECK_CLAUDE_REMOTE_CONTROL=0 で無効化できる。
if [[ "${ISSUE_DECK_CLAUDE_REMOTE_CONTROL:-1}" != "0" ]]; then
  if claude --help 2>/dev/null | grep -q -- "--remote-control"; then
    CLAUDE_EXTRA_ARGS+=(--remote-control "$SESSION_NAME")
  else
    echo "#$ISSUE_NUMBER: 情報: このClaude Codeは --remote-control に未対応のため、外部からの操作は使えません。" >&2
  fi
fi

# セッションへ最初に渡すプロンプト（#1105）。プロンプトファイルの中身をそのまま渡すのではなく、
# 「そのファイルを読んで着手せよ」という1行だけを渡す。理由は3つ。
#
# - 何らかの理由でこのプロンプトがセッションに届かなかったとき、この1行を貼り直すだけで復帰
#   できる。数KBのプロンプト全文を貼り直すのは現実的でない
# - 実装エージェントは起動直後にファイルを読むため、渡した後にプロンプトが再生成されても
#   （同じIssueで再起動した場合など）最新の内容で動く
# - `ps` の出力にIssue本文が丸ごと出るのを避けられる
#
# ただし番号とファイルパスだけだと、後からセッションを開いた人には「何の実装だったか」が
# 分からない（#1405）。そこでタイトルだけをこの1行に載せる。**載せるのはタイトルまでで、
# 本文は載せない**（`ps`に本文が出るのを避ける上の理由は残っている。本文はプロンプトファイルを
# 読めば分かる）。
#
# タイトルは呼び出し元から引数で受け取らず、**プロンプトファイルから読む**。呼び出し元
# （start-issue.sh・generic-start-issue.sh）はtmuxへ渡すコマンド文字列にプロンプトファイルの
# パスしか埋めない方針で、Issue由来のテキストをそこへ持ち込まないため。
# `- タイトル: `の行はissue-deck用（scripts/prompts/implementation-agent.md）と汎用
# （scripts/prompts/generic-implementation-agent.md）の両テンプレートで共通なので、
# どちらのランチャー経由でも同じ処理で取れる。**読めなければタイトル無しの従来の文面へ落とす**
# （書式が変わってもセッションの起動は止めない）。
ISSUE_TITLE=""
if [[ -f "$PROMPT_FILE" ]]; then
  ISSUE_TITLE="$(sed -n 's/^- タイトル: *//p' "$PROMPT_FILE" | head -n 1)"
fi

if [[ -n "$ISSUE_TITLE" ]]; then
  KICKOFF_PROMPT="Issue #$ISSUE_NUMBER「$ISSUE_TITLE」の実装を開始してください。あなたへの指示は $PROMPT_FILE にあります。まずこのファイルを読み、確認を待たずにそのまま指示に従って着手してください。"
else
  KICKOFF_PROMPT="Issue #$ISSUE_NUMBER の実装を開始してください。あなたへの指示は $PROMPT_FILE にあります。まずこのファイルを読み、確認を待たずにそのまま指示に従って着手してください。"
fi

# 貼り直し用に、渡すプロンプトを起動前に必ず表示しておく。起動直後のセッションが何も始めない
# 場合（初回起動時のフォルダ信頼確認など、こちらから制御できない要因で失われうる）に、
# ここからコピーすれば実装を始められる。
echo
echo "#$ISSUE_NUMBER: セッションへ次の1行を渡します。もし起動直後に何も始まらなければ、この行を貼り付けてください。"
echo "  $KICKOFF_PROMPT"
echo

# 権限モード（#1205）。既定は `auto`。
# `acceptEdits` はファイル編集だけを自動承認し、Bashコマンドは都度確認するため、
# `npx tsc --noEmit`・`npx vitest run`・`gh issue comment` のたびにセッションが停止する。
# 人が横にいない実行（サブPC・外出先からの起動）ではこれが致命的なので、既定を `auto` にする。
# 代わりに失われる「個々のコマンドを人が目視する機会」は、Pull Request必須・
# `claude-review-develop.yml`のレビュー・自動マージ不可カテゴリ（`00.check-user`）・
# Issueごとのworktree分離という後段の防御で受ける。
# 慎重に進めたいときは ISSUE_DECK_CLAUDE_PERMISSION_MODE=acceptEdits で従来の挙動に戻せる。
# `bypassPermissions` は全権限チェックを飛ばし破壊的な操作も無確認で通るため、既定にはしない。
# 値の妥当性検査はclaude側に任せる（ここで列挙を持つとclaudeの更新でずれる）。不正な値は
# claudeが起動時にエラーで落ちるため、意図しないモードで動き出すことはない。
PERMISSION_MODE="${ISSUE_DECK_CLAUDE_PERMISSION_MODE:-auto}"

echo "#$ISSUE_NUMBER: Claude Codeセッション「$SESSION_NAME」を権限モード $PERMISSION_MODE で起動します..."
# 受付コメント（#1119）は`claude`を起動する直前に投げる。**ここより後ろには置けない**
# （`claude`はフォアグラウンドで走り、戻ってくるのはセッションが終わったとき）。
report_session_started_to_issue_deck
# set -u 下で空配列の展開がエラーにならないよう ${arr[@]+...} で囲む
# tailnetへ公開したURLをフック（#1219）からも読めるようにする（#1265）。フックはclaudeの
# 子プロセスなので、ここでexportしておけば通知にも載せられる。**セッション通知は入力待ちで
# 飛ぶ**ので、そこにプレビューのURLがあると、気づいた側がその場で画面を開ける。
export ISSUE_DECK_PREVIEW_URL="$PREVIEW_URL"

claude --permission-mode "$PERMISSION_MODE" ${CLAUDE_EXTRA_ARGS[@]+"${CLAUDE_EXTRA_ARGS[@]}"} "$KICKOFF_PROMPT"
