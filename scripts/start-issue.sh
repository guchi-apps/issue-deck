#!/usr/bin/env bash
# issue-deck-local-session: v2
#
# Issueごとに専用ブランチ・git worktreeを作成し、実装エージェント用のClaude Codeセッションを起動する
#
# 冒頭の `issue-deck-local-session:` は「ローカル起動プロトコル」の版数を宣言するマーカー（#1073）。
# ワンクリック起動の受け口（scripts/start-local-session.sh）と画面がこの行を見て、対応可否を
# 判定する。issue-deck自身もこの契約に従う側なので、他リポジトリと同じように宣言する。
# 約束の内容は docs/multi-agent/local-quick-start.md を参照。
#
# 使い方:
#   scripts/start-issue.sh <issue番号> [issue番号...]
#   scripts/start-issue.sh --prepare-only <issue番号> [issue番号...]
#   scripts/start-issue.sh --recreate <issue番号>      既存worktreeを捨ててdevelopから作り直す
#   scripts/start-issue.sh --no-recreate <issue番号>   作り直しの確認を出さず必ず再利用する
#   scripts/start-issue.sh --no-tmux <issue番号>       tmuxを使わずこのターミナルで起動する
#   scripts/start-issue.sh --agent codex <issue番号>   Claude Codeではなく Codex CLI で起動する（#2377）
#
# `--agent`（既定は`claude`）で起こすエージェントCLIを選ぶ。`ISSUE_DECK_AGENT=codex`でも同じ。
# **Codexでは揃わないものがある**（フックによる通知・Remote Control・Plan modeの承認・前回会話の
# 引き継ぎ）。何が使えて何が使えないかは docs/multi-agent/codex.md を参照。
#
# --prepare-only はworktree・ブランチ・起動用プロンプトの準備だけを行い、開発サーバーも
# Claude Codeセッションも起動せずに終了する。VSCodeのClaude Codeタブから `/issue <番号>`
# で呼ぶ用途（既にセッションの中にいるので、さらにclaudeを起動しても意味がない。#1049）。
#
# worktreeが既にある場合は作り直さず再利用する。一度閉じたセッションに戻るための経路であり、
# ワンクリック起動（画面の「ローカルで開始」）を2回目以降に押しても使える（#1076）。
# ただしそのIssueのPRが既にマージ済みなら、developから分岐し直されていない古いブランチのまま
# 作業を始めてしまわないよう警告し、安全に捨てられる場合は作り直すかを尋ねる（#1100）。
# 溜まったworktreeの掃除は scripts/cleanup-worktrees.sh が行う。サブPCではディスパッチpollerが
# 1時間ごとに呼ぶ（#1716）。**このスクリプトは掃除を呼ばない**。worktreeを作った直後は
# 「未コミットの変更なし・developに未反映のコミット0件」で削除対象の条件を満たしてしまうため、
# 掃除側に「起動の準備から30分」の猶予（--min-age-minutes）を持たせて棲み分けている。
#
# 起動時にIssueへ `11.local`（無人実行との二重起動を防ぐ停止フラグ。#1097）を付け、進捗
# （Project Statusの `Planning`/`Implementation`。#1096）を報告する。どの起動経路
# （ターミナル・画面のボタン・`/issue`）もこのスクリプトを通るため、ここに置けば付け忘れが
# 起きない。進捗ラベルは #991 Phase 5（#1010）で廃止しており、報告先はissue-deckの
# 進捗報告API（`POST /api/progress`）だけになっている。
#
# セッションの出口（どこでClaude Codeを走らせるか）は**tmuxがあるかどうかだけ**で決まる（#1178）。
#
#   tmuxがある  Issueごとの新しいtmuxセッション（単一Issueならそのままアタッチする）
#   tmuxが無い  このターミナル（複数Issue指定時は準備だけ行い、手動実行を案内する）
#
# ターミナルを閉じてもSSHが切れてもセッションが残るため、外出先の端末からTailscale SSHで
# 入って実装を始める使い方（#1176 Phase 1）が成立する。WSLでも同じ経路を使う。
# このターミナルで動かしたい場合は `--no-tmux` を付ける。
#
# **Windows Terminalの新しいタブを開く出口は持たない。** 以前は複数Issue指定時に
# `wt.exe -w 0 new-tab` を使っていたが、tmuxで代替できるうえ、Windowsに依存しない経路へ
# 寄せたほうが起動元（サブPC・SSH・無人実行）を選ばないため削除した。
#
# 環境変数:
#   ISSUE_DECK_SKIP_LAN_SETUP=1   LANアクセス設定（Windowsの管理者権限が必要）を行わない
#   ISSUE_DECK_DEV_PORT_BASE=4000 開発サーバーのポートのベース値（未設定ならissue-deckの帯=4000）
#   ISSUE_DECK_DEV_PORT_WIDTH=2000 ポート帯の幅（未設定ならissue-deckの帯の幅=2000。#2478）
#   ISSUE_DECK_DEV_HOST           開発サーバーの待ち受けアドレス（未設定なら127.0.0.1・#1526）
#
# 前提:
#   - gh コマンドで認証済みであること
#   - pnpm install 済み（本体の node_modules は使わず、worktreeごとに個別インストールする）
#
# 本体リポジトリの作業ツリー（ブランチ・uncommitted changes）には一切触れない。
# develop の最新化は git fetch のみで行い、git worktree add で新しいブランチ・作業ディレクトリを作る。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 端末のタイトル・tmuxのセッション名に出すリポジトリ名。複数リポジトリ・複数Issueのセッションを
# 同時に開くため、「どのリポジトリのどのIssueか」が名前だけで分かるようにする（#1105）。
REPO_NAME="$(basename -s .git "$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || true)")"
if [[ -z "$REPO_NAME" || "$REPO_NAME" == "." ]]; then
  REPO_NAME="$(basename "$ROOT")"
fi
WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
PROMPT_DIR="$WORKTREE_BASE/.prompts"

# shellcheck source=scripts/lib/worktree-status.sh
source "$ROOT/scripts/lib/worktree-status.sh"
# 本体の .env.local からworktreeへ環境変数を供給する処理は、汎用ランチャー（#1224）と共有する。
# shellcheck source=scripts/lib/env-file-sync.sh
source "$ROOT/scripts/lib/env-file-sync.sh"
# 起動時の進捗（Project Status）報告も同じく汎用ランチャーと共有する（#1236）。
# shellcheck source=scripts/lib/progress-report.sh
source "$ROOT/scripts/lib/progress-report.sh"
# 個人設定・共有知識がメインPCとサブPCで取り残されていないかの警告（#1190）。
# shellcheck source=scripts/lib/personal-config-sync.sh
source "$ROOT/scripts/lib/personal-config-sync.sh"

# shellcheck source=scripts/lib/claude-auto-mode-setup.sh
source "$ROOT/scripts/lib/claude-auto-mode-setup.sh"
# 本体の作業ツリーの scripts/ が origin/develop より古いままになっていないかの警告（#1274）。
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$ROOT/scripts/lib/launcher-scripts-sync.sh"
# 起動プロンプトへ差し込む「今の状況」（#1267）。汎用ランチャーと共有する
# shellcheck source=scripts/lib/prompt-context.sh
source "$ROOT/scripts/lib/prompt-context.sh"
# 計画が前提としたコミットからの陳腐化検知（#1215）。**止めず、見せるだけ**。
# shellcheck source=scripts/lib/plan-base.sh
source "$ROOT/scripts/lib/plan-base.sh"
# worktreeを作り直す前に開発サーバーを止める（#1524）。止め方は run-issue-session.sh・
# reap-dev-servers.sh・cleanup-worktrees.sh と共有する。
# shellcheck source=scripts/lib/dev-server.sh
source "$ROOT/scripts/lib/dev-server.sh"

# セッションと一緒に動くもの（run-issue-session.sh・session-notify.sh・プロンプトのひな形）を
# どこから読むかを決める（#1438）。本体の作業ツリーが単に古いだけの場合は origin/develop の
# 同期コピーを使い、フックとプロンプトだけが古いまま動き続けるのを防ぐ。**判断に迷ったら
# 作業ツリー**で、手元に未コミットの変更があればこれまでどおりそちらを使う（詳細はlib側の冒頭）。
# 引数の検証より前に置くのは、ここで PROMPT_TEMPLATE の場所が決まるため。
resolve_launcher_scripts_dir "$ROOT"
PROMPT_TEMPLATE="$LAUNCHER_SCRIPTS_DIR/prompts/implementation-agent.md"
# Codexで起こしたときだけプロンプトの末尾へ足す読み替え（#2377）。ひな形と同じ場所から読む。
CODEX_SUPPLEMENT="$LAUNCHER_SCRIPTS_DIR/prompts/codex-supplement.md"

# 起こすエージェントCLIの種別（#2377）。`--agent`（または`ISSUE_DECK_AGENT`）で切り替える。
# shellcheck source=scripts/lib/agent-cli.sh
source "$ROOT/scripts/lib/agent-cli.sh"

# 端末のタイトル（タブ名）を書き換える。worktree作成・pnpm installの間も、どのIssueの準備中かが
# タイトルから分かるようにする（#1105）。この後Claude Codeが起動すると、同じ書式の`--name`
# （scripts/run-issue-session.sh）が引き継ぐ。
# 端末以外へ出力しているときは、エスケープシーケンスがログに混ざるだけなので何もしない。
set_terminal_title() {
  [[ -t 1 ]] || return 0
  printf '\033]0;%s\007' "$1"
}

# tmuxのセッション名（#1178）。端末のタイトル（`<リポジトリ名> #<番号>`）と同じ内容を、tmuxで使える
# 文字だけで表す。`.`・`:`はtmuxのターゲット指定（`session:window.pane`）の区切りとして
# 解釈されるためセッション名に使えず、空白と`#`も指定のたびにクォートが要る。
# サブPCはissue-deck専用機ではなく他リポジトリのセッションも並ぶため、リポジトリ名を含める。
tmux_session_name() {
  local n="$1"
  local safe_repo="${REPO_NAME//[^A-Za-z0-9_-]/-}"
  printf '%s-issue-%s' "$safe_repo" "$n"
}

PREPARE_ONLY=0
# マージ済みIssueのworktreeを作り直すかどうか。auto=マージ済みを検出したら対話で尋ねる（#1100）
RECREATE_MODE=auto
# セッションの出口。auto=tmuxがあればtmux、無ければこのターミナル（#1178）
TMUX_MODE=auto
# 起こすエージェント（#2377）。既定は環境変数、無ければ`claude`
AGENT_KIND_RAW="${ISSUE_DECK_AGENT:-}"
# `--agent codex`（値が次の引数）を受けるための状態。`--agent=codex`の形も受ける
AGENT_VALUE_PENDING=0
POSITIONAL=()
for arg in "$@"; do
  if [[ "$AGENT_VALUE_PENDING" == "1" ]]; then
    AGENT_KIND_RAW="$arg"
    AGENT_VALUE_PENDING=0
    continue
  fi
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --recreate) RECREATE_MODE=always ;;
    --no-recreate) RECREATE_MODE=never ;;
    --no-tmux) TMUX_MODE=classic ;;
    --agent) AGENT_VALUE_PENDING=1 ;;
    --agent=*) AGENT_KIND_RAW="${arg#--agent=}" ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

if [[ "$AGENT_VALUE_PENDING" == "1" ]]; then
  echo "Error: --agent には種別を指定してください（${AGENT_CLI_KINDS[*]}）。" >&2
  exit 1
fi

# 不正な値はここで止める（worktreeを作る前）。
agent_cli_resolve_kind "$AGENT_KIND_RAW" || exit 1
AGENT_KIND="$AGENT_CLI_KIND"
AGENT_COMMAND="$(agent_cli_command_name "$AGENT_KIND")"
# tmuxの中（run-issue-session.sh）と、tmuxが無い環境の`exec bash`の両方へ届かせる。
export ISSUE_DECK_AGENT="$AGENT_KIND"

# ワンクリック起動（scripts/start-local-session.sh）から呼ばれた場合に立つ。LANアクセス設定は
# Windowsの管理者権限を要求し、wt.exeで開いたタブではUACを承認しても待ちから戻らずタブが
# 固まるため、この経路では行わない（#1076）。
SKIP_LAN_SETUP="${ISSUE_DECK_SKIP_LAN_SETUP:-0}"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/start-issue.sh [--prepare-only] [--recreate|--no-recreate] [--no-tmux] [--agent claude|codex] <issue番号> [issue番号...]" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh コマンドが見つかりません。" >&2
  exit 1
fi

if [[ "$PREPARE_ONLY" -eq 0 ]] && ! command -v "$AGENT_COMMAND" >/dev/null 2>&1; then
  echo "Error: $AGENT_COMMAND コマンドが見つかりません（$(agent_cli_display_name "$AGENT_KIND")）。" >&2
  # 未導入のまま起動すると、worktreeだけ作られてセッションが立たない。導入の入口をここで示す。
  if [[ "$AGENT_KIND" == "codex" ]]; then
    # npm版でもTUIは起こせるが`codex agents`・`codex remote-control`が動かないため、
    # standalone installを案内する（#2521。docs/multi-agent/codex.md）。
    echo "       導入: curl -fsSL https://chatgpt.com/codex/install.sh | sh && codex login（docs/multi-agent/codex.md）" >&2
  fi
  exit 1
fi

# サンドボックスを組み立てられるかを、worktreeを作る前に下見する（#2526）。
#
# **`codex`が入っていても、ホストが非特権user namespaceを制限していると即死する。**
# Ubuntu 24.04の既定（`kernel.apparmor_restrict_unprivileged_userns = 1`）がそれで、Codexが
# 同梱するbubblewrapがサンドボックスを組み立てられない。ここを見ないと、worktreeと開発サーバーを
# 用意し受付コメントまで投げた後で、エージェントがコマンドを1本も実行できずに終わる
# （実例: #2511。指示ファイルもworktreeも読めずに終了した）。
#
# **判定できないとき（`unknown`）は止めない。** `codex sandbox`を持たない版でも、TUIのセッション
# 自体は起こせる可能性がある。証拠があるときだけ塞ぐ。
if [[ "$PREPARE_ONLY" -eq 0 && "$AGENT_KIND" == "codex" ]]; then
  CODEX_SANDBOX_PROBE="$(agent_cli_codex_sandbox_probe)"
  if [[ "$(agent_cli_codex_sandbox_probe_state "$CODEX_SANDBOX_PROBE")" == "broken" ]]; then
    echo "Error: Codexのサンドボックス（$(agent_cli_codex_sandbox_mode)）をこのホストで組み立てられません。" >&2
    echo "       $(agent_cli_codex_sandbox_probe_reason "$CODEX_SANDBOX_PROBE")" >&2
    echo "       このまま起動しても、エージェントはコマンドを1本も実行できずに終わります。" >&2
    echo "       ホスト側の対処（AppArmorのuserns制限を緩める）は guchi-apps/subpc#77。" >&2
    echo "       急ぐ場合の逃げ道: ISSUE_DECK_CODEX_SANDBOX=danger-full-access scripts/start-issue.sh --agent codex <番号>" >&2
    echo "       ただし書き込みをworktreeに閉じる層が消えます（docs/multi-agent/codex.md「サンドボックスを組み立てられないホスト」）。" >&2
    exit 1
  fi
fi

# worktreeを作ってから落ちると中途半端な状態が残るため、先に確認する。ワンクリック起動の
# タブは非対話シェルで始まり、nvmを ~/.bashrc に置いていると読まれない（#1085）。
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm コマンドが見つかりません（nvmを使っている場合、非対話シェルでは ~/.bashrc が読まれません）。" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: $PROMPT_TEMPLATE がありません。" >&2
  exit 1
fi

# **読み替えが無いままCodexで起こさない**（#2377）。Claude Code前提の記述（Plan mode・承認
# プロンプト・ツール名）だけが残ったプロンプトを渡すと、存在しない手順を待って止まる。
if [[ "$AGENT_KIND" != "claude" && ! -f "$CODEX_SUPPLEMENT" ]]; then
  echo "Error: $CODEX_SUPPLEMENT がありません（$AGENT_KIND で起動するには必要です）。" >&2
  exit 1
fi

for n in "$@"; do
  if [[ ! "$n" =~ ^[0-9]+$ ]]; then
    echo "Error: issue番号は数字で指定してください: $n" >&2
    exit 1
  fi
done

# 個人設定（`~/.claude/CLAUDE.md`・個人skill）と共有知識が、もう一方のマシンの更新を
# 取り込めていない場合に警告する（#1190）。起動は止めない。
warn_personal_config_drift

# `~/.claude/settings.json`の`permissions.defaultMode`を`auto`に揃える（#2733）。
# CLI引数の`--permission-mode auto`だけではauto modeの同意が打ち消され、読み取り専用の
# コマンドまで1件ずつ承認を求められる。書けなくても起動は止めない。
ensure_claude_auto_mode_default

# 起動スクリプト・フックの実体は本体の作業ツリーにあり、worktreeを作り直しても新しくならない。
# developへ入った修正が反映されていない場合に警告する（#1274）。起動は止めない。
# **同期コピーを使えた場合も警告自体は出す**（start-issue.sh自身とプロンプトのひな形は
# 作業ツリーから読むため。文面はlib側で出し分ける）。
warn_launcher_scripts_stale "$ROOT"

if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
  echo "情報: セッション側のスクリプトとプロンプトのひな形は $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から読みます（#1438）。"
  # tmux経由（build_env_prefix）だけでなく、tmuxが無い環境の`exec bash ...`でも同じものが
  # 届くようexportしておく。run-issue-session.sh はこの2つで自分の素性を知る
  export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA="$LAUNCHER_SCRIPTS_SHA"
  export ISSUE_DECK_LAUNCHER_ROOT="$ROOT"
fi

mkdir -p "$PROMPT_DIR"

# 前回の会話を引き継ぐかどうか（#1541）の**呼び出し元の指定**。Issueごとに上書きするため、
# ループに入る前にここで控えておく（複数のIssueを一度に渡せるので、前のIssueの判定が
# 次のIssueへ漏れないようにする）。実際の値は prepare_issue がworktreeの扱いを見て決める。
CLAUDE_RESUME_REQUESTED="${ISSUE_DECK_CLAUDE_RESUME:-1}"

# マージ済みPRを持つ既存worktreeを作り直すかどうかを決める（#1100）。作り直す場合のみ0を返す。
# 判断材料と、作り直さない場合の理由もここで表示する。
decide_recreate() {
  local n="$1" merged_pr="$2" dirty_count="$3"
  echo "#$n: 警告: このIssueのPR #$merged_pr は既にマージ済みです。"
  echo "#$n: 　　　 ブランチ issue-$n はdevelopへ取り込み済みで、以降のdevelopの変更を含みません。"

  if [[ "$RECREATE_MODE" == "never" ]]; then
    echo "#$n: --no-recreate が指定されているため、このまま再利用します。"
    return 1
  fi

  # 「入っていないコミットがある」の判定はorigin/developが最新であることが前提。再開経路では
  # まだfetchしていないため、ここで最新化する（失敗しても判定は削除しない側に倒れるだけ）。
  git -C "$ROOT" fetch origin develop >/dev/null 2>&1 || true

  # 作り直す＝worktreeとブランチを消すこと。消して失われるものが残っている場合は作り直さない。
  local blocker=""
  if [[ "$dirty_count" -gt 0 ]]; then
    blocker="未コミットの変更が $dirty_count 件あります"
  elif ! worktree_branch_in_develop "$ROOT" "issue-$n"; then
    blocker="origin/develop に入っていないコミットがあります"
  elif worktree_session_running "$n" "$WORKTREE_BASE"; then
    blocker="このIssueのセッションまたは開発サーバーが動いています"
  fi
  if [[ -n "$blocker" ]]; then
    if [[ "$RECREATE_MODE" == "always" ]]; then
      echo "Error: --recreate が指定されていますが、${blocker}。手動で確認してください。" >&2
      exit 1
    fi
    echo "#$n: ただし${blocker}。作り直すと失われるため、このまま再利用します。"
    return 1
  fi

  if [[ "$RECREATE_MODE" == "always" ]]; then
    return 0
  fi

  # ワンクリック起動のタブは端末を持つので尋ねられる。--prepare-only（Claude Codeのタブから
  # 呼ばれる経路）は端末を持たないため、勝手に消さず案内だけ出して再利用する。
  if [[ ! -t 0 ]]; then
    echo "#$n: 非対話実行のため、このまま再利用します。最新のdevelopから作り直す場合は --recreate を付けて実行してください。"
    return 1
  fi

  local answer
  read -r -p "#$n: worktreeを削除して最新のdevelopから作り直しますか？ [Y/n]: " answer
  case "$answer" in
    [nN]|[nN][oO]) echo "#$n: 既存のworktreeをそのまま使います。"; return 1 ;;
    *) return 0 ;;
  esac
}

# 既存のworktree・ブランチを削除する。作り直し自体は呼び出し元の新規作成経路に任せる。
remove_worktree() {
  local n="$1" dir="$2"
  # 自分の足元を消すとgitの内部状態を巻き込むため、カレントディレクトリが対象の中なら止める。
  local current_dir
  current_dir="$(pwd -P)"
  if [[ "$current_dir" == "$dir" || "$current_dir" == "$dir"/* ]]; then
    echo "Error: 削除対象のworktreeの中で実行されているため作り直せません: $dir" >&2
    echo "       別のディレクトリ（例: $ROOT）へ移動してから実行してください。" >&2
    exit 1
  fi
  echo "#$n: 既存のworktree・ブランチを削除しています..."
  # **消す前に開発サーバーを止める**（#1524）。作り直しの判定（worktree_session_running）は
  # PIDファイルと`run-issue-session.sh`のプロセスしか見ないため、実装エージェントが手で
  # 起こし直した`pnpm dev`はすり抜ける。消えたworktreeを指したまま走り続け、次の起動は
  # ポートを掴まれて`EADDRINUSE`になる（#1523の孤児）。
  local dev_port
  dev_port="$(dev_server_port_for_issue "$n" || true)"
  if [[ -n "$dev_port" ]]; then
    dev_server_stop_by_port "$dev_port" "$dir" "$WORKTREE_BASE/.dev-servers/issue-$n.log" "worktreeの作り直し" ||
      echo "警告: #$n: ポート $dev_port を掴んでいた開発サーバーを停止できませんでした。" >&2
  fi
  if ! git -C "$ROOT" worktree remove "$dir"; then
    echo "Error: worktreeの削除に失敗しました: $dir" >&2
    exit 1
  fi
  # コミットがすべて origin/develop に入っていることを確認済みなので -D でよい（-d は
  # 現在のHEADを基準に判定するため、本体が別のIssueブランチを開いていると消せない）。
  git -C "$ROOT" branch -D "issue-$n" >/dev/null
  rm -f "$WORKTREE_BASE/.dev-servers/issue-$n.log" "$WORKTREE_BASE/.dev-servers/issue-$n.pid"
}

# 起動時にIssueへ `11.local` を付ける（#1097）。
#
# ローカルセッションで対応中であることを示す停止フラグで、付いている間は無人実行
# （`claude-issue-dispatch.yml`）がこのIssueに手を出さない。
#
# ラベル付与に失敗しても起動は止めない（起動できないより、記録が遅れる方が軽い。画面の
# 「ローカルで開始」ボタンも同じ方針を取っている）。
apply_start_labels() {
  local n="$1"
  # 既に付いているラベル名（1行1つ）。判定に使うだけなのでIssue取得のJSONから読み、
  # 追加のAPI呼び出しはしない。
  local existing="$2"

  if printf '%s\n' "$existing" | grep -Fxq "11.local"; then
    echo "#$n: 11.local は付与済みです。"
    return 0
  fi

  if gh issue edit "$n" --repo guchi-apps/issue-deck --add-label "11.local" >/dev/null; then
    echo "#$n: ラベルを付与しました（11.local）。"
  else
    echo "#$n: 警告: ラベル（11.local）の付与に失敗しました。手動で付けてください。" >&2
  fi
}

# 起動時の進捗（Project Status）の報告は scripts/lib/progress-report.sh が持つ（#1236）。
# 報告先と鍵の探し方（環境変数 → 本体の`.env.local` → サブPCの`dispatch.env`）もそちらを参照。

# issue番号ごとにworktree・ブランチを準備し、起動用プロンプトを生成する。
# 戻り値として WORKTREE_DIR / PROMPT_FILE / DEV_PORT をグローバル変数に設定する。
prepare_issue() {
  local n="$1"
  WORKTREE_DIR="$WORKTREE_BASE/issue-$n"
  PROMPT_FILE="$PROMPT_DIR/issue-$n.md"
  set_terminal_title "$REPO_NAME #$n"

  # 既存のworktreeは作り直さず再利用する（#1076）。ただしworktreeとして壊れている場合や
  # 別ブランチを開いている場合は、意図しない場所で作業を続けることになるため止める。
  local reuse_worktree=0
  if [[ -e "$WORKTREE_DIR" ]]; then
    if ! git -C "$WORKTREE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "Error: $WORKTREE_DIR はgitの作業ツリーではありません。中身を確認して削除してください。" >&2
      exit 1
    fi
    local current_branch
    current_branch="$(git -C "$WORKTREE_DIR" branch --show-current)"
    if [[ "$current_branch" != "issue-$n" ]]; then
      echo "Error: $WORKTREE_DIR が開いているのは issue-$n ではなく ${current_branch:-(デタッチHEAD)} です。" >&2
      exit 1
    fi
    reuse_worktree=1
    echo "#$n: 既存のworktreeを再利用します（$WORKTREE_DIR）。"
    local dirty_count
    dirty_count="$(worktree_dirty_count "$WORKTREE_DIR")"
    if [[ "$dirty_count" -gt 0 ]]; then
      echo "#$n: 未コミットの変更が $dirty_count 件あります。前回の続きから作業してください。"
    fi

    # マージ済みのIssueで再開すると、developから分岐し直されないまま古いブランチで作業を
    # 始めてしまう。#1076で再開できるようにしたぶん、黙って進むと気づきにくい（#1100）。
    local merged_pr
    merged_pr="$(worktree_merged_pr "$n")"
    if [[ -n "$merged_pr" ]] && decide_recreate "$n" "$merged_pr" "$dirty_count"; then
      remove_worktree "$n" "$WORKTREE_DIR"
      reuse_worktree=0
    fi
  fi

  echo "#$n: Issue内容を取得しています..."
  local issue_json
  if ! issue_json="$(gh issue view "$n" --repo guchi-apps/issue-deck --json number,title,body,labels,comments)"; then
    echo "Error: issue #$n の取得に失敗しました。" >&2
    exit 1
  fi

  # ラベル付与と進捗の報告は、worktree作成やpnpm installより先に行う。二重起動の停止フラグ
  # （`11.local`）は早く立つほど効くうえ、以降の重い処理が失敗しても着手した記録は残る。
  local issue_labels
  if issue_labels="$(printf '%s' "$issue_json" | python3 -c 'import json, sys; print("\n".join(l["name"] for l in json.load(sys.stdin).get("labels") or []))')"; then
    apply_start_labels "$n" "$issue_labels"
    report_start_progress "$ROOT" "guchi-apps/issue-deck" "$n" "$issue_labels"
  else
    # 解析できないまま進めると、`21.plan-required`の有無を取り違えて計画フェーズを飛ばしかねない
    # のでスキップする。
    echo "#$n: 警告: ラベル一覧を解析できなかったため、起動時のラベル付与・進捗の報告をスキップします。" >&2
  fi

  if [[ "$reuse_worktree" -eq 0 ]]; then
    echo "#$n: develop を最新化しています..."
    git -C "$ROOT" fetch origin develop

    echo "#$n: worktree・ブランチ issue-$n を作成しています..."
    if ! git -C "$ROOT" worktree add "$WORKTREE_DIR" -b "issue-$n" origin/develop; then
      echo "Error: worktree/ブランチの作成に失敗しました（ブランチ issue-$n が既に存在する可能性があります）。" >&2
      echo "       マージ済みのブランチが残っているだけなら scripts/cleanup-worktrees.sh --issue $n で掃除できます。" >&2
      exit 1
    fi
  fi

  # 前回の会話を引き継ぐかどうか（#1541）。**worktreeを新規に作った・作り直した場合は引き継がない。**
  # 会話履歴はworktreeではなくcwdのパスに紐づいて残るため、`--recreate`で作り直しても
  # ここを塞がないと古い前提のまま再開する。再利用したときだけ呼び出し元の指定に従う。
  if [[ "$reuse_worktree" -eq 1 ]]; then
    export ISSUE_DECK_CLAUDE_RESUME="$CLAUDE_RESUME_REQUESTED"
  else
    export ISSUE_DECK_CLAUDE_RESUME=0
  fi

  # 再開時は既存の .env.local を尊重する（ローカルで書き換えている場合があるため）。
  # 無いときだけ本体からコピーし、既にある場合は不足しているキーだけを補う（#1099）。
  if [[ ! -f "$WORKTREE_DIR/.env.local" ]]; then
    if [[ -f "$ROOT/.env.local" ]]; then
      cp "$ROOT/.env.local" "$WORKTREE_DIR/.env.local"
    else
      echo "警告: $ROOT/.env.local が無いため .env.local をコピーしませんでした。" >&2
    fi
  elif [[ -f "$ROOT/.env.local" ]]; then
    sync_missing_env_keys "$n" "$ROOT/.env.local" "$WORKTREE_DIR/.env.local"
  fi

  # 開発サーバーのポートをIssueごとに一意にする（複数worktreeで同時にpnpm devしても衝突しないように）。
  # ワンクリック起動からはissue-deck側の受け口がベース値を渡してくる。リポジトリごとの帯を
  # 一箇所で管理するための約束で（#1073）、渡されない場合は既定の4000を使う。
  #
  # **既定値はissue-deck自身の帯（4000）と一致させる**（#1178）。ターミナル直叩き・tmux経路は
  # 受け口を通らずベース値が渡ってこないため、既定値が帯とずれていると、同じIssue番号でも
  # 起動経路によって別のポートになる。1台のマシンに複数リポジトリのセッションが常駐する
  # サブPCでは、そのずれがそのまま他リポジトリの帯との衝突になる。帯の一覧は
  # docs/multi-agent/local-quick-start.md を参照。
  #
  # **採番は`dev_server_port_for_issue`に任せる**（#2470）。ブラウザのブロック対象
  # （`6566`・`10080`など）に当たる場合の繰り上げと、帯の幅（issue-deckは2000）を超えたときの
  # 折り返し（#2478）を、採番する側と止める側（`--recreate`前の`remove_worktree`・
  # cleanup-worktrees.sh）で同じ計算にするため。ここで自前で足すと、動いたセッションを
  # 止める側が見つけられなくなる。
  DEV_PORT="$(dev_server_port_for_issue "$n")"
  if DEV_PORT_NOTE="$(dev_server_port_note "$n" "${ISSUE_DECK_DEV_PORT_BASE:-4000}" "${ISSUE_DECK_DEV_PORT_WIDTH:-2000}" "$DEV_PORT")"; then
    echo "#$n: 注記: $DEV_PORT_NOTE"
  fi
  # **envファイルへの書き込みは補助**（#2464）。ポートの受け渡しの本体は環境変数`PORT`で、
  # run-issue-session.shがexportする。ここはissue-deck自身のworktree（必ず`.env.local`を持つ）
  # 向けで、手で`pnpm dev`を叩き直す経路のために書いておく。
  if [[ -f "$WORKTREE_DIR/.env.local" ]]; then
    # `sed`で消して追記する形にすると、再開のたびに先頭改行が積もって空行が増える（実測で
    # 何度も再開したworktreeだけ空行が4行多かった）。既存行があれば置換する共通スクリプトを使う。
    bash "$ROOT/scripts/update-env-file.sh" "$WORKTREE_DIR/.env.local" PORT "$DEV_PORT"
  fi
  echo "#$n: 開発サーバーはポート $DEV_PORT を使用します（http://localhost:$DEV_PORT）"

  SSLIP_URL=""
  if [[ "$PREPARE_ONLY" -eq 1 ]]; then
    # 開発サーバーを起動しないので、この時点でポートフォワーディングを設定する意味がない。
    # UACダイアログを出さずに済ませる（必要になったらdevサーバー起動時に設定する）。
    echo "#$n: --prepare-only のためLANアクセス設定はスキップします。"
  elif [[ "$SKIP_LAN_SETUP" != "0" ]]; then
    # ワンクリック起動経路。UACを承認しても待ちから戻らずタブが固まるため行わない（#1076）。
    echo "#$n: LANアクセス設定はスキップします（LAN内の別端末から見る場合は scripts/setup-lan-access.sh $DEV_PORT を実行してください）。"
  elif ! command -v powershell.exe >/dev/null 2>&1; then
    # WSL以外（サブPCのUbuntu等）。ここで必要だったのはWSL2の内部NATを越えるための
    # Windows側ポートフォワーディングで、素のLinuxには対応物が無い。
    # setup-lan-access.sh も同じ判定で何もせず終わるが、ここで分けておくと何が行われなかったかが
    # ログに残る。
    #
    # **開発サーバーの待ち受けは`127.0.0.1`に閉じている（#1526）。** 別端末から見る経路は
    # `tailscale serve`のFQDNで、LANの生IPからは見えない。
    echo "#$n: LANアクセス設定はスキップします（WSL以外の環境では不要。開発サーバーは 127.0.0.1 に閉じており、別端末からは tailscale serve のURLで見ます）。"
  else
    echo "#$n: LANアクセス用のポートフォワーディングを設定しています（Windowsの管理者権限が必要です）..."
    if bash "$ROOT/scripts/setup-lan-access.sh" "$DEV_PORT"; then
      WSL_IP="$(ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' || true)"
      if [[ -n "$WSL_IP" ]]; then
        SSLIP_URL="http://${WSL_IP}.sslip.io:${DEV_PORT}"
      fi
    else
      echo "#$n: 警告: LANアクセス設定に失敗しました。localhostでの確認は引き続き可能です。" >&2
    fi
  fi

  echo "#$n: pnpm install しています..."
  (cd "$WORKTREE_DIR" && pnpm install)

  echo "#$n: 起動用プロンプトを生成しています..."
  # 起動プロンプトへ差し込む「今の状況」（#1267）。集めるだけで判断はしない
  local issue_relations concurrent_work
  issue_relations="$(prompt_context_relations "guchi-apps/issue-deck" "$n")"
  concurrent_work="$(prompt_context_concurrent "guchi-apps/issue-deck" "$n" "$WORKTREE_DIR" develop)"

  # 計画の前提（`<!-- plan-base: <SHA> -->`）からdevelopへ入った変更（#1215）。
  # **再開時こそ効く。** 計画を出してから承認されるまでの間に他セッションのマージが入ると、
  # 承認された計画の前提が既に無効になっていることがある（#1200 で2回起きた）。
  # `$issue_json` は上で `--json ...,comments` 付きで取得済みなので、ghの呼び出しは増やさない。
  local plan_base_sha plan_base_lines
  plan_base_sha="$(printf '%s' "$issue_json" | plan_base_sha_from_comments)"
  if [[ -n "$plan_base_sha" ]]; then
    # `origin/develop` が古いと変化を見落とす。再利用経路ではまだfetchしていないことがある
    # （fetchするのは新規作成時と作り直しの判定時だけ）ので、ここで最新化する。
    git -C "$ROOT" fetch origin develop --quiet 2>/dev/null || true
    plan_base_lines="$(plan_base_changes "$ROOT" "$plan_base_sha" develop)"
    echo "#$n: 計画の前提（plan-base ${plan_base_sha:0:7}）以降に origin/develop へ入った変更:"
    printf '%s\n' "$plan_base_lines" | sed "s/^/#$n:   /"
    # **端末に出すだけにしない。** 再開したエージェント自身が読む必要がある。既存の
    # `{{CONCURRENT_WORK}}`へ相乗りするので、プロンプトのひな形は変えなくてよい。
    # `$( )` は末尾の改行を落とすため、行頭に自分で改行を足す（足さないと直前の行へ繋がる）
    concurrent_work+=$'\n'"- 計画の前提（\`plan-base: ${plan_base_sha:0:7}\`）以降に\`origin/develop\`へ入った変更:"$'\n'
    concurrent_work+="$(printf '%s\n' "$plan_base_lines" | sed 's/^/  - /')"$'\n'
  fi
  local issue_json_file
  issue_json_file="$(mktemp)"
  printf '%s' "$issue_json" >"$issue_json_file"
  local dev_log="$WORKTREE_BASE/.dev-servers/issue-$n.log"
  # prompt-render:start（scripts/implementation-prompt.test.mjs がこの範囲を切り出して実行する）
  python3 - "$issue_json_file" "$PROMPT_TEMPLATE" "$DEV_PORT" "$SSLIP_URL" "$dev_log" "$PREPARE_ONLY" "$WORKTREE_DIR" "$issue_relations" "$concurrent_work" "$AGENT_KIND" "$LAUNCHER_SCRIPTS_DIR" >"$PROMPT_FILE" <<'PY'
import json
import sys

issue_json_path, template_path, dev_port, sslip_url, dev_log = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
# --prepare-only では開発サーバーを起動しない。プロンプト側の「起動済み」という記述が
# 嘘にならないよう、この値で文面を分ける。
prepare_only = sys.argv[6] == "1"
worktree_dir = sys.argv[7]
issue_relations = sys.argv[8]
concurrent_work = sys.argv[9]
# 起こすエージェントCLIの種別（#2377）。計画の出し方だけはここで文面を差し替える（#2551）
agent_kind = sys.argv[10] if len(sys.argv) > 10 else "claude"
# 実際に走らせる`scripts/`の絶対パス（#1438・#2590）。Codexの計画の出し方で案内する
# `submit-plan.sh`の在り処で、汎用ランチャー（cwdが他リポジトリのworktree）と共有するため
# 相対では書けない
scripts_dir = sys.argv[11] if len(sys.argv) > 11 else "scripts"

with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

label_names = {l["name"] for l in issue.get("labels", [])}
labels = ", ".join(sorted(label_names)) or "(なし)"

# 別端末から見るための案内。**メインPC（WSL）はsslip.io、サブPCはtailscale serve**（#1265）で
# 経路が違うため、決め打ちで書かない。tailnetのURLは起動時にしか分からない（ホスト名が
# ホスト依存）ので、起動ログの行を見るよう促す。
if sslip_url:
    sslip_note = f"（スマホ等、同一LAN上の別端末から確認する場合は`{sslip_url}`を使う）"
else:
    sslip_note = (
        "（別端末から確認する場合は、起動ログの「開発サーバーをtailnetへ公開しました」の行に"
        "出ているtailnetのURLを使う。出ていなければこのホストからは公開できていない）"
    )

if prepare_only:
    dev_server_state = (
        "このworktree用の開発サーバーは**まだ起動していません**。画面確認が必要になったら "
        "`cd {worktree} && pnpm dev` でバックグラウンド起動してください（ポート`{port}`は"
        "`.env.local`に設定済みなので、そのまま`pnpm dev`でよい）"
    ).format(worktree=worktree_dir, port=dev_port)
else:
    # 開発サーバーは一定時間アクセスが無いと回収される（#1223）。落ちていることを想定外の事故と
    # 受け取って調査に入られると無駄なので、起こし方まで先に伝えておく。
    #
    # **`pnpm dev`だけで起こし直せる**（#1329・#1363）。`dev.sh`が待ち受けを`127.0.0.1`へ倒して
    # `EADDRINUSE`を避け（#1526）、開発サーバーの停止に伴って撤去された`tailscale serve`の公開も
    # 張り直す（#1363）。ここに別のコマンドを書く必要はない。
    dev_server_state = (
        "このworktree用の開発サーバーはセッション開始時に自動起動済み（ログ: `{dev_log}`）。"
        "ただし**一定時間アクセスが無いと自動で停止される**ため、画面確認のときに繋がらなければ "
        "`cd {worktree} && pnpm dev` で起こしてよい（tailnetへ公開している場合も同じコマンドでよく、"
        "起こし直せばtailnetのURLからも再び見える。停止した理由はログの末尾に残っている）"
    ).format(dev_log=dev_log, worktree=worktree_dir)

if "23.preview-required" in label_names:
    preview_instructions = (
        "このIssueには`23.preview-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に次の手順を行ってください。\n\n"
        "1. `http://localhost:{port}` で実際の画面を確認する"
        "（{dev_server_state}）{sslip_note}\n"
        "2. 確認した画面・操作手順と**別端末から開けるURL**をユーザーに提示し、問題ないか"
        "明示的な承認を得る（ユーザーは外出先のスマホから開くため、`localhost`のURLでは届かない）。"
        "**承認可否は`AskUserQuestion`で尋ねること。** そうするとフックが自動で`00.check-user`を付け、"
        "issue-deckの画面の「ユーザーの確認待ち」に出ます（答えた時点で自動的に外れます。#1417）\n"
        "3. 承認が得られてから初めてPRを作成する（ローカル実行では、承認が得られるまで応答を止めて待つ。"
        "無人実行の場合は`00.check-user`を付与して停止し、承認後に再開する）"
    ).format(port=dev_port, sslip_note=sslip_note, dev_server_state=dev_server_state)
else:
    preview_instructions = (
        "このworktreeの開発サーバー（`pnpm dev`）はポート`{port}`を使います"
        "（他Issueのworktreeと同時に起動しても衝突しません）。{dev_server_state}。"
        "画面に関わる変更を行った場合、PR本文の「確認方法」に次の情報を含めてください。\n\n"
        "- アクセスURL（`http://localhost:{port}`）{sslip_note}\n"
        "- 実際に確認すべき画面・操作手順\n\n"
        "承認待ちで止まる必要はなく、そのままPR作成まで進めてよいです。"
    ).format(port=dev_port, sslip_note=sslip_note, dev_server_state=dev_server_state)

if "24.screenshot-required" in label_names:
    screenshot_instructions = (
        "このIssueには`24.screenshot-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に次の手順を行ってください。\n\n"
        f"1. `run`スキル等を使って開発サーバー（ポート`{dev_port}`）上で変更箇所のスクリーンショットを取得する"
        "（Playwright等の新規依存関係の追加が必要な場合は、追加前に必ずユーザーに確認する）\n"
        "2. 取得したスクリーンショットをユーザーに提示し、問題ないか明示的な承認を得る。"
        "**承認可否は`AskUserQuestion`で尋ねること。** そうするとフックが自動で`00.check-user`を付け、"
        "issue-deckの画面の「ユーザーの確認待ち」に出ます（答えた時点で自動的に外れます。#1417）\n"
        "3. 承認が得られてから初めてPRを作成する（ローカル実行では、承認が得られるまで応答を止めて待つ。"
        "無人実行の場合は`00.check-user`を付与して停止し、承認後に再開する）"
    )
else:
    screenshot_instructions = (
        "このIssueには`24.screenshot-required`ラベルが付いていないため、"
        "Playwright等によるスクリーンショットの自動取得は不要です（トークン消費が大きいため）。"
    )

# 見た目のアーティファクト（#1473・#1540）。**出すのは実装着手前**（#1540）。実装が済んでから
# 見せる形だと、見た目がNGだったときに実装がまるごとやり直しになるため、ゲートをPR作成前から
# 実装着手前へ移した。実装後の見た目は23.preview-required（実物）が受け持つ。
# **計画レビューで見た目が変わったときの差し替え手順もここに書く**（#2110）。手順そのものは#1745で
# 決めてdocs/multi-agent/labels.mdに書いてあるが、汎用ランチャーで起動した他リポジトリのセッションから
# issue-deckのdocs/は読めず、実際に手順が届かずに止まった（guchi-apps/myroom#109）。
# **同じ文面が scripts/generic-start-issue.sh と
# src/lib/prompts/build-implementation-prompt.ts にもある。** 起動経路によって指示が
# 変わらないよう、変えるときは3か所そろえる（scripts/lib/agent-language.sh と同じ構造）。
if "25.artifact-required" in label_names:
    artifact_instructions = (
        "このIssueには`25.artifact-required`ラベルが付いています。**コードを書き始める前に**、"
        "変更する画面の見た目を自己完結HTMLのアーティファクトとして公開し、URLを提示して"
        "見た目の承認を得てから実装に入ってください。\n\n"
        "- **画面デザインは原則PC・iPad・スマホの3画面を並べて提示してください**（#1632・#2460）。"
        "1つのアーティファクトの中に、PC（デスクトップ幅）・**iPad（横向き = 幅1180px × 高さ820px）**・"
        "**スマホ（iPhone 15 = 幅393px × 高さ852px）**の見た目を、この順（広い順）で並べます。"
        "iPadは幅768pxを超えるためスマホ用の画面へは切り替わらず、PCと同じ配置が狭い幅で出るため、"
        "PC・スマホのどちらの1枚にもその崩れは現れません。減らす場合は、その理由を"
        "アーティファクト本文に書いてください\n"
        "- **アーティファクトは実装前の見た目案であって実物ではありません。** 承認の意味は"
        "「この見た目で作ってよい」までで、実装が正しいことの確認にはなりません。実装後の見た目は"
        "開発サーバーの実画面で確かめてください。この但し書きはアーティファクト本文の先頭にも書きます\n"
        "- `21.plan-required`が併用されている場合は、**Plan modeに入る前に公開**し、URLを計画本文へ"
        "含めてください（Plan modeで書けるのは計画ファイルだけなので、最初の1枚はPlan modeへ入る"
        "前に作ります）。計画と見た目を1回のやり取りで承認できます\n"
        "- 計画本文へURLを載せるときは、`アーティファクト: <URL>（計画のやり取りで見た目が変わった"
        "場合は、承認後・コードを書く前に同じURLへ差し替えます）`のように**差し替えがあり得ることも"
        "添えて**ください。計画レビューで見た目が変わるのは正常な流れで、断りが無いと古い版のURLが"
        "承認済みの記録として残ります\n"
        "- **計画のやり取りで見た目の直しを求められたら、計画ファイルの中で差し替えます**（#2200）。"
        "Plan modeで書けるのはやはり計画ファイルだけですが、**その中に置いたHTMLはissue-deckが"
        "取り出して「アーティファクト」カードへ取り込みます。**「Plan modeでは差し替えられません」と"
        "答えて先送りしないでください。手順は4つです。(1) 計画ファイルの末尾に`## アーティファクト`の"
        "見出しを作る (2) その下に`<!-- artifact: <最初に公開したHTMLファイルの絶対パス> -->`を1行"
        "置く (3) 続けて**バッククォート4つ＋`artifact`**で開くフェンス（閉じも同じ数）にHTML全文を"
        "入れる (4) `ExitPlanMode`で計画を出し直す。パスを公開時と同じにすると同じカードが差し替わり、"
        "計画コメントにHTMLは載りません\n"
        "- 承認の直後、コードを書く前に**最初と同じファイルパス**へそのHTMLを書き、`Artifact`を"
        "呼び直して再公開してください。**差し替わるのは先にissue-deckのカードだけで、claude.aiの"
        "URLはこの再公開までは修正前の見た目のままです。** パスが同じなら同じURLへ再デプロイ"
        "されるため、計画コメントに残ったリンクもそのまま新しい見た目を指すようになります。"
        "**パスが1文字でも違うとカードが2枚に増えます**\n"
        "- **見た目の直しだけを再承認させるゲートは足しません**（#1745）。直しは計画の"
        "「修正を送る」の1往復に相乗りさせ、承認は1回に保ちます\n"
        "- `21.plan-required`が付いていない場合は、アーティファクトの提示そのものが承認ゲートです。"
        "承認可否は`AskUserQuestion`で尋ね（フックが自動で`00.check-user`を付け、答えた時点で"
        "外れます。#1417）、URLはIssueコメントにも残してください\n"
        "- 実装後にPR本文へURLを貼る必要はありません。出来上がった画面の確認は開発サーバー"
        "（`23.preview-required`）の役割です\n"
        "- アーティファクトは既定で非公開です。共有するかどうかを決めるのはユーザーです\n"
        "- 開発サーバーのURLと違い、セッションが終了した後も残ります。スマホなど別端末からの確認に向きます\n"
        "- アーティファクトを作れるのはローカルセッションだけです（無人実行では作成できません）"
    )
else:
    artifact_instructions = (
        "このIssueには`25.artifact-required`ラベルが付いていないため、"
        "見た目のアーティファクトの作成は不要です。"
        "ただし、ユーザーの求めなどで画面デザインをアーティファクトとして出す場合は、"
        "**PC（デスクトップ幅）・iPad（横向き = 幅1180px × 高さ820px）・"
        "スマホ（iPhone 15 = 幅393px × 高さ852px）の3画面を1つのアーティファクトに"
        "広い順で並べて提示してください**（#1632・#2460）。"
        "Plan modeの最中に見た目の直しを求められた場合も、計画ファイルの末尾へ"
        "`<!-- artifact: <HTMLファイルの絶対パス> -->`とHTML全文（バッククォート4つ＋`artifact`の"
        "フェンス）を置いて計画を出し直せば、issue-deckが「アーティファクト」カードへ"
        "取り込みます（#2200）。"
    )

if agent_kind == "codex":
    artifact_instructions += (
        "\n\nCodexで画面デザインをHTMLとして作った場合は、ローカルHTTPサーバーの"
        "`localhost` URLを計画へ載せないでください。**次のコマンドでIssueDeckへ登録し、"
        f"返された`https://issuedeck.gucchii.com/artifacts/<id>`形式のURLを計画へ記載してください**。"
        f"\n\n`{scripts_dir}/lib/codex-artifact.sh <HTMLファイル>`\n\n"
        "同じファイルパスで再実行すると既存のアーティファクトを更新できます。"
        "登録に失敗した場合はエラー内容をIssueコメントへ残し、localhost URLだけを共有URLとして扱わないでください。"
    )

# 計画の出し方は**エージェントによって道具が違う**ので、ここで文面ごと差し替える（#2551）。
# 読み替えを末尾の補足（scripts/prompts/codex-supplement.md）だけに置いていたときは、本文側の
# 「フックが自動で投稿します／無ければ手で投稿します」に従ったCodexのセッションが計画を
# `gh issue comment`で自分で投稿し、画面に承認パネルが出ないまま実装へ進んでいた（#2550）。
# **矛盾する指示を残さないことが要点**で、43KBの本文を分岐させるわけではない。
if agent_kind == "codex":
    plan_instructions = (
        "ラベルに `21.plan-required` が含まれる場合は、実装前に計画を一時的なMarkdownファイルへ"
        f"書き、`{scripts_dir}/submit-plan.sh <計画ファイル>`を実行してください"
        "（書き方は後述の「計画は要約から書き、30〜40行に収める」に従います）。"
        "このコマンドが計画コメントの投稿・`00.check-user`の付与・issue-deckの画面への"
        "承認パネルの表示までを行い、判断が届くまで待ちます。"
        "**計画を`gh issue comment`で自分で投稿しないでください**——画面に承認パネルが出ず、"
        "ユーザーは承認も修正もできません。"
        "終了コード`0`なら標準出力を確認してください。承認なら実装へ進み、修正依頼なら表示された"
        "内容を反映して同じコマンドで出し直してください。修正依頼もCodexが出力を次の計画へ"
        "使えるよう成功終了（`0`）で返ります。`3`が期限切れ・通信失敗（実装へ進まず、端末で"
        "ユーザーへ確認する）です。"
        "含まれない場合はそのまま実装に進んでよいです。"
    )
    plan_comment_note = (
        f"  - **`{scripts_dir}/submit-plan.sh`が、計画コメントの投稿（`plan-base`のSHA付き）と"
        "`00.check-user`＋`01.check-plan`の付与まで行います**（#2545）。"
        "同じ計画を`gh issue comment`で投稿し直さないでください。"
        f"`gh issue view {issue['number']} --comments`で投稿されていることを確かめ、"
        "**コマンドが失敗して投稿されていないときだけ**上記のとおり手で投稿します"
    )
else:
    plan_instructions = (
        "ラベルに `21.plan-required` が含まれる場合は、実装前にPlan modeでアプローチ・変更範囲・"
        "懸念点をまとめて提示し、承認を得てから実装に入ってください"
        "（書き方は後述の「計画は要約から書き、30〜40行に収める」に従います）。"
        "含まれない場合はそのまま実装に進んでよいです。"
    )
    plan_comment_note = (
        "  - **Plan modeの`ExitPlanMode`で計画を提示した場合、フックが同じ内容"
        "（`plan-base`のSHAとRemote Controlへのリンク付き）を自動でIssueへ投稿し、"
        "`00.check-user`と理由ラベル`01.check-plan`を付けます**（#1342・#1490）。"
        "その場合は同じ計画を手で投稿し直さないでください。"
        f"`gh issue view {issue['number']} --comments`で投稿されていることを確かめ、"
        "**無ければ**上記のとおり手で投稿します"
    )

comments = issue.get("comments", [])
if comments:
    comment_text = "\n\n".join(
        "- {login} ({created_at}):\n{body}".format(
            login=(c.get("author") or {}).get("login", "unknown"),
            created_at=c.get("createdAt", ""),
            body=c.get("body", ""),
        )
        for c in comments
    )
else:
    comment_text = "(コメントなし)"

result = (
    template.replace("{{ISSUE_NUMBER}}", str(issue["number"]))
    .replace("{{ISSUE_TITLE}}", issue["title"])
    .replace("{{ISSUE_LABELS}}", labels)
    .replace("{{ISSUE_BODY}}", issue.get("body") or "(本文なし)")
    .replace("{{ISSUE_COMMENTS}}", comment_text)
    .replace("{{ISSUE_RELATIONS}}", issue_relations or "（取得できませんでした）")
    .replace("{{CONCURRENT_WORK}}", concurrent_work or "（取得できませんでした）")
    .replace("{{DEV_PORT}}", dev_port)
    .replace("{{PREVIEW_INSTRUCTIONS}}", preview_instructions)
    .replace("{{SCREENSHOT_INSTRUCTIONS}}", screenshot_instructions)
    .replace("{{ARTIFACT_INSTRUCTIONS}}", artifact_instructions)
    .replace("{{PLAN_INSTRUCTIONS}}", plan_instructions)
    .replace("{{PLAN_COMMENT_NOTE}}", plan_comment_note)
)
sys.stdout.write(result)
PY
  # prompt-render:end
  rm -f "$issue_json_file"

  # Codexで起こす場合だけ、読み替えの補足をプロンプトの末尾へ足す（#2377）。
  #
  # **実装プロンプト本体を分岐させない。** ひな形は43KBあり、Codex専用の写しを作れば片方が
  # 必ず古くなる。共通の指示はそのままにして、**Claude Code前提で書かれている箇所の読み替え**
  # （Plan mode・承認プロンプト・ツール名）だけを差分として追記する。
  #
  # **`{{ISSUE_DECK_SCRIPTS_DIR}}`はここで絶対パスへ直す**（#2590）。汎用ランチャーと読み替えを
  # 共有するため、`submit-plan.sh`・`submit-question.sh`の在り処をプレースホルダにしてある。
  if [[ "$AGENT_KIND" != "claude" && -f "$CODEX_SUPPLEMENT" ]]; then
    agent_cli_append_codex_supplement "$CODEX_SUPPLEMENT" "$PROMPT_FILE" "$LAUNCHER_SCRIPTS_DIR"
  fi
}

# tmuxセッションへ引き継ぐ環境変数（#1178）。新しいセッションはtmuxサーバー側の環境を
# 引き継ぐため、このプロセスのexportがそのまま届くとは限らない。値は%qでクォートして埋める。
# 設定されているものだけを渡し、未設定のものは新しいシェル側の既定に任せる。
build_env_prefix() {
  local var value prefix=""
  # ISSUE_DECK_SESSION_REAPABLE / ISSUE_DECK_SESSION_STATE_DIR はセッションの自動回収（#1256）用。
  # 前者はpollerがジョブとして起動した経路でだけ渡ってくる印で、tmuxの中まで届かないと
  # 記述子に載らず、回収の対象にならない。
  # ISSUE_DECK_CLAUDE_RESUME は前回の会話を引き継ぐかどうか（#1541）。prepare_issue が
  # worktreeの扱いを見て決めた値で、tmuxの中まで届かないと新規worktreeでも再開してしまう。
  # ISSUE_DECK_AGENT は起こすエージェントCLIの種別（#2377）。tmuxの中まで届かないと、
  # `--agent codex`で起動したつもりでもClaude Codeが立つ。
  for var in ISSUE_DECK_WORKTREE_BASE ISSUE_DECK_SHARED_CONTEXT_DIR ISSUE_DECK_SKIP_LAN_SETUP \
    ISSUE_DECK_DEV_HOST ISSUE_DECK_SESSION_REAPABLE ISSUE_DECK_SESSION_STATE_DIR \
    ISSUE_DECK_CLAUDE_RESUME ISSUE_DECK_AGENT ISSUE_DECK_CLAUDE_MODEL ISSUE_DECK_CODEX_MODEL \
    ISSUE_DECK_CODEX_SANDBOX ISSUE_DECK_CODEX_EXTRA_ARGS; do
    value="${!var:-}"
    [[ -n "$value" ]] || continue
    prefix+="export $var=$(printf '%q' "$value"); "
  done
  # 同期コピーから起動した場合の情報（#1438）。run-issue-session.sh は自分の置き場所しか
  # 知らないため、**本体の作業ツリーがどこかと、同期コピーで走っていることをここから渡す**。
  # 渡さないと、tmuxのpaneに出す警告（#1426）が本体の作業ツリーを見に行けなくなる。
  if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
    prefix+="export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA=$(printf '%q' "$LAUNCHER_SCRIPTS_SHA"); "
    prefix+="export ISSUE_DECK_LAUNCHER_ROOT=$(printf '%q' "$ROOT"); "
  fi
  printf '%s' "$prefix"
}

# 単一worktree内で開発サーバー起動〜エージェント起動〜終了時のdevサーバー停止までを行う
# run-issue-session.sh を起動するコマンド文字列を作る（PROMPT_FILEのパスのみを埋め込み、
# Issue本文・コメントなどの外部由来テキストはコマンド文字列に直接展開しない）。
build_session_cmd() {
  local issue_number="$1"
  local worktree_dir="$2"
  local dev_port="$3"
  local prompt_file="$4"
  printf "%scd %q && bash %q %q %q %q" "$(build_env_prefix)" "$worktree_dir" "$LAUNCHER_SCRIPTS_DIR/run-issue-session.sh" "$issue_number" "$dev_port" "$prompt_file"
}

# tmuxの新しいセッションでrun-issue-session.shを起動する（#1178）。
start_tmux_session() {
  local n="$1" session="$2" worktree_dir="$3" cmd="$4"

  # 同名のセッションが動いていれば作らない。再開（#1076）で2回目に起動したときに、
  # 前のセッションを残したまま同じIssueのセッションが二重に立つのを防ぐ。
  if tmux has-session -t "=$session" 2>/dev/null; then
    # ただし後述の`remain-on-exit`で残した「死んだペインだけのセッション」は、動いているのでは
    # なく前回の終了の痕跡なので、最後の出力を見せてから畳んで作り直す。残したままだと
    # 再実行しても「既に動いています」で止まり、二度と起動できない。
    local alive_panes
    alive_panes="$(tmux list-panes -s -t "=$session" -F '#{pane_dead}' 2>/dev/null | grep -cv '^1$' || true)"
    if [[ "${alive_panes:-0}" -eq 0 ]]; then
      # tmux 3.2以降は異常終了時だけ残る。3.2未満（`on`へフォールバックした環境）では
      # 正常終了でも残るため、「異常終了した」とは断定しない。終了コードは下の出力に出る。
      echo "#$n: 前回のtmuxセッション「$session」は終了したまま残っていました。最後の出力:"
      # capture-paneはペイン指定なので、セッション指定の`=`接頭辞ではなく`<セッション名>:`
      # （そのセッションの現在のウィンドウ＝アクティブなペイン）で指す。
      tmux capture-pane -p -t "$session:" 2>/dev/null | grep -v '^$' | tail -n 15 | sed 's/^/    /' || true
      tmux kill-session -t "=$session" >/dev/null 2>&1 || true
    else
      echo "#$n: tmuxセッション「$session」は既に動いています。新しくは起動しません。"
      return 0
    fi
  fi

  # tmuxはコマンドを既定シェルで直接実行し、**ログインシェルとしては起動しない**。
  # `~/.profile`系が読まれずPATHに`~/.local/bin`が乗らないため、そのままではclaudeが
  # 見つからずセッションが即死する（#1177で実際に踏んだ）。`bash -lc`を明示して、
  # node/pnpm/claude/gh とトークン類をまとめてログインシェルに解決させる。個別にPATHを
  # 足す方法もあるが、後から増えた環境変数を取りこぼす。
  if ! tmux new-session -d -s "$session" -c "$worktree_dir" "bash -lc $(printf '%q' "$cmd")"; then
    echo "Error: tmuxセッション「$session」の起動に失敗しました。" >&2
    return 1
  fi

  # 異常終了時にペインを残す。既定ではコマンドの終了と同時にセッションごと消えるため、
  # **エラーメッセージが一切残らない**（#1177で原因究明に手間取った）。`failed`はtmux 3.2以降で、
  # 異常終了のときだけ残す。古いtmux（メインPCのWSLは3.0a）では`unknown value`で失敗するため、
  # 常に残す`on`へ落とす。この場合は正常終了でもセッションが残るが、次回同じIssueで起動した
  # ときに上の分岐が畳んで作り直すので、溜まったまま起動できなくなることはない。
  #
  # これはウィンドウのオプションなので、対象はセッション名ではなく`<セッション名>:`
  # （＝そのセッションの現在のウィンドウ）で指す。セッション指定の`=`接頭辞は付かない。
  tmux set-option -t "$session:" -w remain-on-exit failed >/dev/null 2>&1 ||
    tmux set-option -t "$session:" -w remain-on-exit on >/dev/null 2>&1 || true
}

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  for n in "$@"; do
    prepare_issue "$n"
    echo "#$n: 準備が完了しました。"
    echo "  worktree: $WORKTREE_DIR"
    echo "  プロンプト: $PROMPT_FILE"
    echo "  開発サーバー用ポート: $DEV_PORT（未起動）"
  done
  exit 0
fi

# セッションの出口を決める（#1178）。**tmuxがあれば必ずtmux。**
# Windows Terminalのタブを開く出口は持たない（WSLでもtmuxを使う）。
TMUX_AVAILABLE=0
if command -v tmux >/dev/null 2>&1; then
  TMUX_AVAILABLE=1
fi

LAUNCHER=tmux
if [[ "$TMUX_MODE" == "classic" || "$TMUX_AVAILABLE" -eq 0 ]]; then
  if [[ "$TMUX_MODE" != "classic" ]]; then
    echo "警告: tmux が見つからないため、このターミナルで起動します（切断するとセッションも終了します）。" >&2
  fi
  LAUNCHER=classic
fi

if [[ "$LAUNCHER" == "tmux" ]]; then
  # Issueごとに独立したtmuxセッションを立てる。ターミナルを閉じてもSSHが切れても残るため、
  # 外出先の端末から入って実装を始め、切断して後から戻る使い方ができる（#1176 Phase 1）。
  for n in "$@"; do
    prepare_issue "$n"
    session="$(tmux_session_name "$n")"
    echo "#$n: tmuxセッション「$session」で開発サーバーとClaude Codeセッションを起動します..."
    start_tmux_session "$n" "$session" "$WORKTREE_DIR" \
      "$(build_session_cmd "$n" "$WORKTREE_DIR" "$DEV_PORT" "$PROMPT_FILE")"
  done

  echo
  echo "起動したセッションはこのターミナルを閉じても（SSHが切れても）動き続けます。"
  # 単一Issueで、端末があり、まだtmuxの外にいる場合はそのままアタッチする。ターミナルから
  # 直接叩いたときに、これまでどおり目の前でセッションが始まったように見える。
  if [[ $# -eq 1 && -t 0 && -t 1 && -z "${TMUX:-}" ]]; then
    echo "アタッチします（切り離すには Ctrl-b d）..."
    exec tmux attach-session -t "=$(tmux_session_name "$1")"
  fi
  for n in "$@"; do
    if [[ -n "${TMUX:-}" ]]; then
      # tmuxの中からは入れ子でアタッチできない。今いるクライアントの切り替えを案内する。
      echo "  #$n: tmux switch-client -t $(tmux_session_name "$n")"
    else
      echo "  #$n: tmux attach -t $(tmux_session_name "$n")"
    fi
  done
  exit 0
fi

if [[ $# -eq 1 ]]; then
  n="$1"
  prepare_issue "$n"
  echo "#$n: 開発サーバーを自動起動し、Claude Codeセッションを起動します（このターミナルで実行）..."
  cd "$WORKTREE_DIR"
  exec bash "$LAUNCHER_SCRIPTS_DIR/run-issue-session.sh" "$n" "$DEV_PORT" "$PROMPT_FILE"
fi

# tmuxが無い環境で複数Issueを指定した場合。1つのターミナルでは1セッションしか動かせないため、
# 準備だけを行い、残りは手動実行に委ねる（別々のターミナルで叩けば並行できる）。
for n in "$@"; do
  prepare_issue "$n"
  echo "#$n: worktreeの準備ができました。以下を手動で実行してください:"
  echo "  cd \"$WORKTREE_DIR\" && bash \"$LAUNCHER_SCRIPTS_DIR/run-issue-session.sh\" \"$n\" \"$DEV_PORT\" \"$PROMPT_FILE\""
done
