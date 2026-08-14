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

# 公開したURLをissue-deckの画面へ渡す（#1265）。**スマホから画面を見る唯一の出口**なので、
# ターミナルのログだけに出しても届かない。宛先と鍵はpollerと同じ`dispatch.env`から読む。
# 受け口は`session-notify.sh`と共有（`POST /api/dispatch/sessions/activity`）。
# **未設定でも失敗してもセッションは止めない。**
report_preview_url_to_issue_deck() {
  local preview_url="$1"
  local env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
  [[ -f "$env_file" ]] || return 0

  local app_base_url dispatch_secret repo_slug body
  # shellcheck disable=SC1090
  app_base_url="$(source "$env_file" >/dev/null 2>&1; printf '%s' "${APP_BASE_URL:-}")"
  # shellcheck disable=SC1090
  dispatch_secret="$(source "$env_file" >/dev/null 2>&1; printf '%s' "${DISPATCH_SECRET:-}")"
  repo_slug="$(git config --get remote.origin.url 2>/dev/null |
    sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##' || true)"
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
}
trap cleanup EXIT HUP TERM

if [[ "$DEV_SERVER_ENABLED" == "0" ]]; then
  echo "#$ISSUE_NUMBER: 開発サーバーは起動しません（画面確認が必要になったら worktree で \`$DEV_COMMAND\` を実行してください。ポート $DEV_PORT は env に設定済みです）。"
else
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

  # tailnetへ出す（#1265）。**バインドは変えない**（localhostのまま`tailscale serve`が
  # プロキシする）。使えないホスト（メインPCのWSL等）では黙って何もしない。
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

# セッションの状態をSignalyへ通知するフック（#1219）。
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
  cat >"$HOOK_SETTINGS_FILE" <<JSON
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "$HOOK_COMMAND" }] }
    ],
    "Stop": [
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
KICKOFF_PROMPT="Issue #$ISSUE_NUMBER の実装を開始してください。あなたへの指示は $PROMPT_FILE にあります。まずこのファイルを読み、確認を待たずにそのまま指示に従って着手してください。"

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
# set -u 下で空配列の展開がエラーにならないよう ${arr[@]+...} で囲む
# tailnetへ公開したURLをフック（#1219）からも読めるようにする（#1265）。フックはclaudeの
# 子プロセスなので、ここでexportしておけば通知にも載せられる。**セッション通知は入力待ちで
# 飛ぶ**ので、そこにプレビューのURLがあると、気づいた側がその場で画面を開ける。
export ISSUE_DECK_PREVIEW_URL="$PREVIEW_URL"

claude --permission-mode "$PERMISSION_MODE" ${CLAUDE_EXTRA_ARGS[@]+"${CLAUDE_EXTRA_ARGS[@]}"} "$KICKOFF_PROMPT"
