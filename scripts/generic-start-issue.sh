#!/usr/bin/env bash
# 汎用ランチャー（#1224）。**対象リポジトリに何も追加せずに**、Issueごとの専用ブランチ・
# git worktreeを作り、実装エージェント用のClaude Codeセッションを起動する。
#
# 使い方:
#   scripts/generic-start-issue.sh <owner> <repo> <issue番号>
#   scripts/generic-start-issue.sh --prepare-only <owner> <repo> <issue番号>
#   scripts/generic-start-issue.sh --no-tmux <owner> <repo> <issue番号>
#
# 呼び出し経路:
#   issue-deckの画面「サブPCで開始」→ ジョブキュー → scripts/subpc-dispatch-poller.sh
#     → scripts/start-local-session.sh <owner> <repo> <番号>
#       → （契約適合のリポジトリ）そのリポジトリの scripts/start-issue.sh
#       → （それ以外）              このスクリプト
#
# ## なぜあるか
#
# 従来は「対象リポジトリが契約適合の scripts/start-issue.sh を持つこと」を対応可否の唯一の
# 真実にしていた（#1073）。メインPCのワンクリック起動（issuedeck:// → WSL）では、Windows
# Terminal・UAC・LANポートフォワーディングといった**起動元の環境差をリポジトリ側のスクリプトが
# 吸収する**必要があったため。しかし対象を1つ増やすたびに700行規模のスクリプトを移植する
# 運用になり、増やしたい数（7リポジトリ）に見合わない。
#
# **サブPC起動に限れば環境差はほぼ無い。** 出口はtmux固定で、Windows依存の処理は要らない
# （#1178でtmux出口を入れた時点で片付いている）。リポジトリごとに違うのはベースブランチ・
# パッケージマネージャ・envファイルの名前・ポート帯・プロンプト文面くらいで、いずれも規約か
# 設定で表現できる。設計の全体像は docs/multi-agent/generic-launcher.md を参照。
#
# ## リポジトリ固有の値の解決方法
#
#   ベースブランチ        origin/HEAD から判定する（develop / main が混在するため）
#   worktree置き場        ~/apps/<repo>-worktrees
#   パッケージマネージャ  detect_package_manager（宣言 → ロックファイル → package.json）
#   envファイル           本体チェックアウトの .env.local / .env をコピーし、不足キーだけ補う
#   node_modules          npm・yarnのリポジトリだけ、本体からハードリンクで敷いてからinstall
#   ポート帯              scripts/local-repo-ports.conf
#   プロンプト            対象リポジトリの scripts/prompts/implementation-agent.md があればそれ、
#                         無ければ scripts/prompts/generic-implementation-agent.md
#   上記で吸収できない事情 対象リポジトリの scripts/issue-session-hooks.sh（任意）
#
# **開発サーバーは既定で起動しない。** サブPCの実効RAMは13Giで、リポジトリ数ぶんのdevサーバーを
# 常駐させる前提が置けない（#1523でOOM Killerが発動した実例がある）。ポートは env に書き込む
# ので、必要なセッションだけ中で起動する。根拠はCPUではなくメモリで、CPUを6C/12Tへ載せ替えても
# 変わらない（#1791）。
#
# 環境変数:
#   ISSUE_DECK_DEV_PORT_BASE            開発サーバーのポートのベース値（受け口が渡す）
#   ISSUE_DECK_DEV_PORT_WIDTH           ポート帯の幅（受け口が渡す。既定は原則の1000。#2478）
#   ISSUE_DECK_GENERIC_WORKTREE_BASE    worktreeの置き場（既定は ~/apps/<repo>-worktrees）
#   ISSUE_DECK_SHARED_CONTEXT_DIR       共有知識リポジトリ（既定は ~/apps/_docs）
#   ISSUE_DECK_CLAUDE_PERMISSION_MODE   claude の権限モード（既定は auto。#1205）
#
# 対象リポジトリの作業ツリー（ブランチ・uncommitted changes）には一切触れない。
# ベースブランチの最新化は git fetch のみで行い、git worktree add で新しいブランチ・作業
# ディレクトリを作る。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

# 対応表の解決・検証とパッケージマネージャの判定は受け口と共有する（判定を二重に持たない）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/env-file-sync.sh
source "$SCRIPT_DIR/lib/env-file-sync.sh"
# npm・yarnのリポジトリのnode_modulesを本体チェックアウトとハードリンクで共有する（#2124）。
# shellcheck source=scripts/lib/node-modules-share.sh
source "$SCRIPT_DIR/lib/node-modules-share.sh"
# 起動時の進捗（Project Status）報告も issue-deck 自身のランチャーと共有する（#1236）。
# shellcheck source=scripts/lib/progress-report.sh
source "$SCRIPT_DIR/lib/progress-report.sh"
# 個人設定・共有知識の同期の取り残しの警告も同じく共有する（#1190）。
# shellcheck source=scripts/lib/personal-config-sync.sh
source "$SCRIPT_DIR/lib/personal-config-sync.sh"
# 起動スクリプト自身（issue-deckの本体の作業ツリー）が古いままの場合の警告（#1274）。
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$SCRIPT_DIR/lib/launcher-scripts-sync.sh"
# 開発サーバーのポートの採番（ブラウザがブロックするポートの繰り上げを含む。#2470）。
# shellcheck source=scripts/lib/dev-server.sh
source "$SCRIPT_DIR/lib/dev-server.sh"
# Pull Requestを人の指示で作るリポジトリかどうか（#2499）。回収（reap-sessions.sh）と共有する。
# shellcheck source=scripts/lib/pr-policy.sh
source "$SCRIPT_DIR/lib/pr-policy.sh"

usage() {
  echo "Usage: scripts/generic-start-issue.sh [--prepare-only] [--no-tmux] <owner> <repo> <issue番号>" >&2
}

PREPARE_ONLY=0
TMUX_MODE=auto
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --no-tmux) TMUX_MODE=classic ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

OWNER="$1"
REPO="$2"
ISSUE_NUMBER="$3"
FULL_NAME="$OWNER/$REPO"

# 引数は外部（ジョブキューのレスポンス）から渡りうるため、呼び出し元で検証済みでも改めて
# 検証する（多層防御。片側の検証が緩んでもここで止まる）。
local_session_validate_target "$OWNER" "$REPO" "$ISSUE_NUMBER" || exit 1

if ! REPO_PATH="$(local_repo_resolve_path "$FULL_NAME")"; then
  echo "Error: $FULL_NAME のローカルチェックアウト先が分かりません（$(local_repos_config_file)）。" >&2
  exit 1
fi
if [[ ! -d "$REPO_PATH/.git" && ! -f "$REPO_PATH/.git" ]]; then
  echo "Error: $REPO_PATH はgitリポジトリではありません。" >&2
  exit 1
fi

# 実装対象が共有知識リポジトリ自身か（#1741）。
#
# 共有知識（`~/apps/_docs` = guchi-apps/docs）は全セッションが`--add-dir`で読む前提の
# チェックアウトで、プロンプトも「読み取り専用」と書いている。そのリポジトリのIssueを起動すると
# **実装対象の本体チェックアウトを参照に加えることになり**、worktreeではなくそちらを直接編集する
# 事故を招くうえ、指示自体が自己矛盾する。
#
# **リポジトリ名では判定しない。** 共有知識の置き場は`ISSUE_DECK_SHARED_CONTEXT_DIR`で差し替えられ、
# ディレクトリ名（`_docs`）もリポジトリ名（`docs`）と一致しない。実体が同じかどうか（`-ef`）だけを見る。
SHARED_CONTEXT_DIR="${ISSUE_DECK_SHARED_CONTEXT_DIR:-$HOME/apps/_docs}"
if [[ -d "$SHARED_CONTEXT_DIR" && "$REPO_PATH" -ef "$SHARED_CONTEXT_DIR" ]]; then
  export ISSUE_DECK_SKIP_SHARED_CONTEXT=1
  echo "#$ISSUE_NUMBER: $FULL_NAME は共有知識リポジトリ自身のため、共有知識の参照（--add-dir）は付けません。"
else
  export ISSUE_DECK_SKIP_SHARED_CONTEXT=0
fi

for required_command in git gh python3; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done
if [[ "$PREPARE_ONLY" -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude コマンドが見つかりません。" >&2
  exit 1
fi

# フォルダの信頼確認が済んでいるか（#1838）。**worktreeを作る前にここで止める。**
# 汎用ランチャーが起こすのは「そのホストでまだClaude Codeを開いたことがないリポジトリ」で
# あることが多く、信頼確認に当たりやすい。当たると答えるまでセッションが始まらず、フックが
# 1つも飛ばないまま止まる（#1465）。判定は`~/.claude.json`を読むだけで、書き換えはしない。
# `--prepare-only`では`claude`を起こさないので確かめない。
# shellcheck source=scripts/lib/claude-trust.sh
source "$SCRIPT_DIR/lib/claude-trust.sh"
if [[ "$PREPARE_ONLY" -eq 0 ]]; then
  claude_trust_require "$REPO_PATH" "$FULL_NAME" || exit 1
fi

# worktreeを作ってから落ちると中途半端な状態が残るため、パッケージマネージャの有無は先に確かめる。
PACKAGE_MANAGER="$(detect_package_manager "$REPO_PATH")"
if [[ -n "$PACKAGE_MANAGER" ]] && ! command -v "$PACKAGE_MANAGER" >/dev/null 2>&1; then
  echo "Error: $FULL_NAME が必要とする $PACKAGE_MANAGER が見つかりません。" >&2
  echo "  nvmを使っている場合、非対話シェルでは ~/.bashrc が読まれません（#1085）。" >&2
  exit 1
fi

# 個人設定（`~/.claude/CLAUDE.md`・個人skill）と共有知識が、もう一方のマシンの更新を
# 取り込めていない場合に警告する（#1190）。起動は止めない。
warn_personal_config_drift

# セッション側のスクリプト（run-issue-session.sh・session-notify.sh）をどこから走らせるかを
# 決める（#1438）。start-issue.sh と同じ扱いで、起動対象のリポジトリではなく起動する側
# （issue-deckの本体の作業ツリー）を見る。
resolve_launcher_scripts_dir "$ROOT"

# このランチャー自身（issue-deckの本体の作業ツリー）がdevelopより古い場合に警告する（#1274）。
# 起動対象のリポジトリではなく、起動する側のスクリプトを見る。
warn_launcher_scripts_stale "$ROOT"

if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
  echo "情報: セッション側のスクリプトは $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行します（#1438）。"
fi

WORKTREE_BASE="${ISSUE_DECK_GENERIC_WORKTREE_BASE:-$HOME/apps/$REPO-worktrees}"
PROMPT_DIR="$WORKTREE_BASE/.prompts"
WORKTREE_DIR="$WORKTREE_BASE/issue-$ISSUE_NUMBER"
PROMPT_FILE="$PROMPT_DIR/issue-$ISSUE_NUMBER.md"
BRANCH="issue-$ISSUE_NUMBER"
# **採番は`dev_server_port_for_issue`に任せる**（#2470）。ブラウザのブロック対象
# （dayspan #566の`6566`・clip-hive #80の`10080`など）に当たる場合の繰り上げと、帯の幅を
# 超えたときの折り返し（#2478）を、採番する側と止める側（cleanup-worktrees.sh）で同じ計算に
# するため。ここで自前で足すと、動いたセッションを止める側が見つけられなくなる。
DEV_PORT_BASE_VALUE="${ISSUE_DECK_DEV_PORT_BASE:-3000}"
DEV_PORT_WIDTH_VALUE="${ISSUE_DECK_DEV_PORT_WIDTH:-1000}"
DEV_PORT="$(dev_server_port_for_issue "$ISSUE_NUMBER" "$DEV_PORT_BASE_VALUE" "$DEV_PORT_WIDTH_VALUE")"
if DEV_PORT_NOTE="$(dev_server_port_note "$ISSUE_NUMBER" "$DEV_PORT_BASE_VALUE" "$DEV_PORT_WIDTH_VALUE" "$DEV_PORT")"; then
  echo "#$ISSUE_NUMBER: 注記: $DEV_PORT_NOTE"
fi

mkdir -p "$PROMPT_DIR"

# --- ベースブランチ -----------------------------------------------------------
# 対象リポジトリによって develop と main が混在するため、リポジトリ名から決め打ちできない。
# `origin/HEAD`（GitHub側の既定ブランチ）を正とする。ローカルに無い場合は取りに行く。
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
  # origin/HEAD が引けない環境（古いclone等）でも起動できるようにする。
  for candidate in develop main master; do
    if git -C "$REPO_PATH" show-ref --verify --quiet "refs/remotes/origin/$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# --- Issueの取得 --------------------------------------------------------------
echo "#$ISSUE_NUMBER: $FULL_NAME のIssue内容を取得しています..."
if ! ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$FULL_NAME" --json number,title,body,labels,comments)"; then
  echo "Error: $FULL_NAME の issue #$ISSUE_NUMBER の取得に失敗しました。" >&2
  exit 1
fi

if ! ISSUE_LABELS="$(printf '%s' "$ISSUE_JSON" |
  python3 -c 'import json, sys; print("\n".join(l["name"] for l in json.load(sys.stdin).get("labels") or []))')"; then
  # 解析できないまま進めると、`21.plan-required`の有無を取り違えて計画フェーズを飛ばしかねない。
  echo "#$ISSUE_NUMBER: 警告: ラベル一覧を解析できなかったため、ラベル付与・進捗の報告をスキップします。" >&2
  ISSUE_LABELS=""
  SKIP_START_REPORT=1
else
  SKIP_START_REPORT=0
fi

# --- ラベル付与と進捗の報告 ---------------------------------------------------
# worktree作成や依存インストールより先に行う。二重起動の停止フラグ（`11.local`）は早く立つほど
# 効くうえ、以降の重い処理が失敗しても着手した記録は残る（start-issue.sh と同じ方針）。

# 進捗報告APIの宛先・鍵の解決と報告そのものは scripts/lib/progress-report.sh が持つ（#1236）。
# **issue-deck自身のランチャー（start-issue.sh）と同じ実装を使う。** 以前はここにだけ
# `dispatch.env`へのフォールバックがあり、issue-deck自身のIssueをサブPCで起動したときだけ
# 進捗が報告されなかった。

# 起動時にIssueへ `11.local` を付ける（#1097）。付いている間は無人実行
# （`claude-issue-dispatch.yml`）がこのIssueに手を出さない。
# **ラベル付与に失敗しても起動は止めない**（起動できないより、記録が遅れる方が軽い）。
apply_start_labels() {
  if printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "11.local"; then
    echo "#$ISSUE_NUMBER: 11.local は付与済みです。"
    return 0
  fi
  if gh issue edit "$ISSUE_NUMBER" --repo "$FULL_NAME" --add-label "11.local" >/dev/null; then
    echo "#$ISSUE_NUMBER: ラベルを付与しました（11.local）。"
  else
    echo "#$ISSUE_NUMBER: 警告: ラベル（11.local）の付与に失敗しました。手動で付けてください。" >&2
  fi
}

if [[ "$SKIP_START_REPORT" -eq 0 ]]; then
  apply_start_labels
  report_start_progress "$ROOT" "$FULL_NAME" "$ISSUE_NUMBER" "$ISSUE_LABELS"
fi

# --- worktreeの作成・再利用 ---------------------------------------------------
# 既存のworktreeは作り直さず再利用する（#1076と同じ方針）。ただしworktreeとして壊れている場合や
# 別ブランチを開いている場合は、意図しない場所で作業を続けることになるため止める。
REUSED_WORKTREE=0
if [[ -e "$WORKTREE_DIR" ]]; then
  if ! git -C "$WORKTREE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Error: $WORKTREE_DIR はgitの作業ツリーではありません。中身を確認して削除してください。" >&2
    exit 1
  fi
  CURRENT_BRANCH="$(git -C "$WORKTREE_DIR" branch --show-current)"
  if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    echo "Error: $WORKTREE_DIR が開いているのは $BRANCH ではなく ${CURRENT_BRANCH:-(デタッチHEAD)} です。" >&2
    exit 1
  fi
  REUSED_WORKTREE=1
  echo "#$ISSUE_NUMBER: 既存のworktreeを再利用します（$WORKTREE_DIR）。"

  # マージ済みのIssueで再開すると、ベースブランチから分岐し直されないまま古いブランチで作業を
  # 始めてしまう（#1100）。無人起動なので尋ねずに警告だけ出す（消す判断は人が行う）。
  MERGED_PR="$(gh pr list --repo "$FULL_NAME" --head "$BRANCH" --state merged --json number \
    --jq '.[0].number // empty' 2>/dev/null || true)"
  if [[ -n "$MERGED_PR" ]]; then
    echo "#$ISSUE_NUMBER: 警告: このIssueのPR #$MERGED_PR は既にマージ済みです。ブランチ $BRANCH は以降のベースブランチの変更を含みません。" >&2
    echo "#$ISSUE_NUMBER: 　　　 作り直す場合は次で worktree を削除してから再実行してください（#2123）:" >&2
    echo "#$ISSUE_NUMBER: 　　　   bash $SCRIPT_DIR/cleanup-worktrees.sh --repo $FULL_NAME --issue $ISSUE_NUMBER" >&2
  fi
fi

if [[ "$REUSED_WORKTREE" -eq 0 ]]; then
  if ! BASE_BRANCH="$(resolve_base_branch)"; then
    echo "Error: $FULL_NAME のベースブランチを判定できませんでした（origin/HEAD が引けません）。" >&2
    exit 1
  fi
  echo "#$ISSUE_NUMBER: ベースブランチ $BASE_BRANCH を最新化しています..."
  git -C "$REPO_PATH" fetch origin "$BASE_BRANCH"

  echo "#$ISSUE_NUMBER: worktree・ブランチ $BRANCH を作成しています（$WORKTREE_DIR）..."
  if ! git -C "$REPO_PATH" worktree add "$WORKTREE_DIR" -b "$BRANCH" "origin/$BASE_BRANCH"; then
    echo "Error: worktree/ブランチの作成に失敗しました（ブランチ $BRANCH が既に存在する可能性があります）。" >&2
    exit 1
  fi
else
  BASE_BRANCH="$(resolve_base_branch || true)"
fi

# 前回の会話を引き継ぐかどうか（#1541）。**worktreeを新規に作った場合は引き継がない。**
# 会話履歴はworktreeではなくcwdのパスに紐づいて残るため、worktreeを消して作り直しても
# ここを塞がないと古い前提のまま再開する。再利用したときだけ呼び出し元の指定に従う。
if [[ "$REUSED_WORKTREE" -eq 1 ]]; then
  export ISSUE_DECK_CLAUDE_RESUME="${ISSUE_DECK_CLAUDE_RESUME:-1}"
else
  export ISSUE_DECK_CLAUDE_RESUME=0
fi

# --- envファイル --------------------------------------------------------------
# 本体チェックアウトの .env.local / .env をworktreeへ供給する。再開時は既存を尊重し、
# 不足キーだけを補う（#1099）。どちらも無いリポジトリでは何もしない。
supply_env_files "$ISSUE_NUMBER" "$REPO_PATH" "$WORKTREE_DIR" .env.local .env

# 開発サーバーのポートをIssueごとに一意にする（同じマシンで複数worktree・複数リポジトリの
# セッションが並ぶため）。**帯はissue-deck側の対応表が持つ**（scripts/local-repo-ports.conf）。
#
# **ここはenvファイルが既にあるときだけ動く。** 本体チェックアウトに`.env.local`も`.env`も
# 無いリポジトリでは`supply_env_files`が何もしないため、この書き込みも起こらない。
# **ポートの受け渡しの本体は環境変数`PORT`**（run-issue-session.shがexportする・#2464）で、
# ここはあくまで手で`pnpm dev`を叩き直す経路のための補助。
for env_name in .env.local .env; do
  if [[ -f "$WORKTREE_DIR/$env_name" ]]; then
    bash "$SCRIPT_DIR/update-env-file.sh" "$WORKTREE_DIR/$env_name" PORT "$DEV_PORT"
  fi
done
echo "#$ISSUE_NUMBER: 開発サーバー用のポートは $DEV_PORT です（既定では起動しません）。"

# --- リポジトリ固有の逃げ道（任意） -------------------------------------------
# 規約と設定で吸収できない事情（DBセットアップ等）は、対象リポジトリが
# scripts/issue-session-hooks.sh を置けば拾う。**無いのが既定**で、あっても失敗は警告に留める
# （フックの失敗でセッションが起動しない方が困る）。
run_repo_hook() {
  local hook_name="$1"
  local hook_file="$WORKTREE_DIR/scripts/issue-session-hooks.sh"
  [[ -f "$hook_file" ]] || return 0
  (
    set +e
    export ISSUE_SESSION_REPOSITORY="$FULL_NAME"
    export ISSUE_SESSION_ISSUE_NUMBER="$ISSUE_NUMBER"
    export ISSUE_SESSION_WORKTREE_DIR="$WORKTREE_DIR"
    export ISSUE_SESSION_MAIN_CHECKOUT="$REPO_PATH"
    export ISSUE_SESSION_DEV_PORT="$DEV_PORT"
    export ISSUE_SESSION_PACKAGE_MANAGER="$PACKAGE_MANAGER"
    cd "$WORKTREE_DIR" || exit 1
    # shellcheck disable=SC1090
    source "$hook_file" || exit 1
    if declare -F "$hook_name" >/dev/null 2>&1; then
      echo "#$ISSUE_NUMBER: リポジトリ固有のフック $hook_name を実行します..."
      "$hook_name"
    fi
  ) || echo "#$ISSUE_NUMBER: 警告: フック $hook_name が失敗しました。続行します。" >&2
}

run_repo_hook issue_session_after_worktree

# --- 依存インストール ---------------------------------------------------------
if [[ -n "$PACKAGE_MANAGER" && -f "$WORKTREE_DIR/package.json" ]]; then
  # **installの前に本体のnode_modulesをハードリンクで敷く**（#2124）。npm・yarnには
  # pnpmのようなストア共有が無く、worktreeごとに実体をコピーするため、1本あたり数百MB〜1GBが
  # そのまま増える。敷いてからinstallすると差分だけが入り、実ディスクの増分は数十MBで済む
  # （速度も数十秒→数秒になる）。pnpm・bunのリポジトリでは何もしない。
  seed_node_modules_from_main "$ISSUE_NUMBER" "$REPO_PATH" "$WORKTREE_DIR" "$PACKAGE_MANAGER"
  echo "#$ISSUE_NUMBER: $PACKAGE_MANAGER install しています..."
  (cd "$WORKTREE_DIR" && "$PACKAGE_MANAGER" install)
else
  echo "#$ISSUE_NUMBER: 依存インストールは不要です（package.json がありません）。"
fi

run_repo_hook issue_session_after_install

# --- プロンプトの生成 ---------------------------------------------------------
# 対象リポジトリが自前のテンプレートを持っていればそれを優先する。持っていなければ
# issue-deck側の汎用テンプレートを使う（対象リポジトリに何も追加しないのが既定）。
PROMPT_TEMPLATE="$WORKTREE_DIR/scripts/prompts/implementation-agent.md"
PROMPT_TEMPLATE_SOURCE="対象リポジトリ"
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  # 汎用テンプレートはセッションへそのまま渡るものなので、フックと同じく同期コピーから読む
  # （#1438。同期コピーを使わない場合は $SCRIPT_DIR と同じ場所を指す）
  PROMPT_TEMPLATE="$LAUNCHER_SCRIPTS_DIR/prompts/generic-implementation-agent.md"
  PROMPT_TEMPLATE_SOURCE="issue-deckの汎用テンプレート"
fi
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: プロンプトのテンプレートがありません（$PROMPT_TEMPLATE）。" >&2
  exit 1
fi

# 起動プロンプトへ差し込む「今の状況」（#1267）。集めるだけで判断はしない
# shellcheck source=scripts/lib/prompt-context.sh
source "$SCRIPT_DIR/lib/prompt-context.sh"
ISSUE_RELATIONS="$(prompt_context_relations "$FULL_NAME" "$ISSUE_NUMBER")"
CONCURRENT_WORK="$(prompt_context_concurrent "$FULL_NAME" "$ISSUE_NUMBER" "$WORKTREE_DIR" "${BASE_BRANCH:-develop}")"

# 計画の前提（`<!-- plan-base: <SHA> -->`）から、ベースブランチへ入った変更（#1215）。
# **止めず、見せるだけ。** マーカーが無いIssue（計画フェーズを経ていない・古い計画）では
# 何も足さずに通常どおり起動する。`$ISSUE_JSON` は `--json ...,comments` 付きで取得済み。
# shellcheck source=scripts/lib/plan-base.sh
source "$SCRIPT_DIR/lib/plan-base.sh"
PLAN_BASE_SHA="$(printf '%s' "$ISSUE_JSON" | plan_base_sha_from_comments)"
if [[ -n "$PLAN_BASE_SHA" ]]; then
  git -C "$REPO_PATH" fetch origin "${BASE_BRANCH:-develop}" --quiet 2>/dev/null || true
  PLAN_BASE_LINES="$(plan_base_changes "$REPO_PATH" "$PLAN_BASE_SHA" "${BASE_BRANCH:-develop}")"
  echo "#$ISSUE_NUMBER: 計画の前提（plan-base ${PLAN_BASE_SHA:0:7}）以降に origin/${BASE_BRANCH:-develop} へ入った変更:"
  printf '%s\n' "$PLAN_BASE_LINES" | sed "s/^/#$ISSUE_NUMBER:   /"
  # 端末に出すだけにしない。再開したエージェント自身が読む必要がある（既存の
  # `{{CONCURRENT_WORK}}` へ相乗りするので、プロンプトのひな形は変えなくてよい）
  # `$( )` は末尾の改行を落とすため、行頭に自分で改行を足す（足さないと直前の行へ繋がる）
  CONCURRENT_WORK+=$'\n'"- 計画の前提（\`plan-base: ${PLAN_BASE_SHA:0:7}\`）以降に\`origin/${BASE_BRANCH:-develop}\`へ入った変更:"$'\n'
  CONCURRENT_WORK+="$(printf '%s\n' "$PLAN_BASE_LINES" | sed 's/^/  - /')"$'\n'
fi

echo "#$ISSUE_NUMBER: 起動用プロンプトを生成しています（$PROMPT_TEMPLATE_SOURCE）..."
DEV_COMMAND="${PACKAGE_MANAGER:-npm} run dev"
if [[ "$PACKAGE_MANAGER" == "pnpm" || "$PACKAGE_MANAGER" == "bun" ]]; then
  DEV_COMMAND="$PACKAGE_MANAGER dev"
fi

# Pull Requestを人の指示で作るリポジトリか（#2499）。**回収側と同じ判定を使う**
# （scripts/lib/pr-policy.sh）。ここだけを手動にすると、PRを作らないまま`11.local`を外した
# セッションが猶予5分で畳まれてしまう。
PR_POLICY="auto"
if pr_policy_is_manual "$FULL_NAME"; then
  PR_POLICY="manual"
  echo "#$ISSUE_NUMBER: このリポジトリではPull Requestを人の指示で作ります（$(pr_policy_config_file)）。"
fi

ISSUE_JSON_FILE="$(mktemp)"
printf '%s' "$ISSUE_JSON" >"$ISSUE_JSON_FILE"
python3 - "$ISSUE_JSON_FILE" "$PROMPT_TEMPLATE" "$FULL_NAME" "$WORKTREE_DIR" "${BASE_BRANCH:-}" \
  "$PACKAGE_MANAGER" "$DEV_COMMAND" "$DEV_PORT" "$ISSUE_RELATIONS" "$CONCURRENT_WORK" \
  "$SHARED_CONTEXT_DIR" "$ISSUE_DECK_SKIP_SHARED_CONTEXT" "$PR_POLICY" >"$PROMPT_FILE" <<'PY'
import json
import sys

(
    issue_json_path,
    template_path,
    repository,
    worktree_dir,
    base_branch,
    package_manager,
    dev_command,
    dev_port,
    issue_relations,
    concurrent_work,
    shared_context_dir,
    skip_shared_context,
    pr_policy,
) = sys.argv[1:14]

with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

label_names = {l["name"] for l in issue.get("labels", [])}
labels = ", ".join(sorted(label_names)) or "(なし)"

# 汎用ランチャーは開発サーバーを起動しない（#1224）。「起動済み」と書くと嘘になる。
preview_instructions = (
    "このworktree用の開発サーバーは**起動していません**（サブPCではリポジトリ数ぶんの"
    "常駐を前提にできないため）。画面確認が必要になったら "
    f"`cd {worktree_dir} && {dev_command}` で起動してください。ポート`{dev_port}`は"
    "envファイルに設定済みなので、そのまま起動してよいです。\n\n"
    "画面に関わる変更を行った場合、PR本文の「確認方法」に次の情報を含めてください。\n\n"
    f"- アクセスURL（`http://localhost:{dev_port}`）\n"
    "- 実際に確認すべき画面・操作手順\n\n"
    "承認待ちで止まる必要はなく、そのままPR作成まで進めてよいです。"
)

if "23.preview-required" in label_names:
    # このラベルが付いたセッションでは、ランチャーが開発サーバーを起動し tailscale serve で
    # tailnetへ出している（#1265）。**起動URLは起動ログに出ている実際の値を使うこと。**
    # ここでホスト名を決め打ちすると、別ホストで起こしたときに嘘になる。
    preview_instructions = (
        "このIssueには`23.preview-required`ラベルが付いています。**開発サーバーは"
        "このセッションの起動時に自動で立ち上がっており、tailnet内から見られるよう"
        "公開されています**（起動ログの「開発サーバーをtailnetへ公開しました」の行にURLが"
        "出ています。公開できなかった場合はその旨が出ています）。\n\n"
        "実装・テストが完了したら、PRを作成する**前**に次の手順を行ってください。\n\n"
        "1. 起動ログに出ているtailnetのURL（`http://<ホスト名>.ts.net:"
        f"{dev_port}`）で実際の画面を確認する。公開されていない場合は "
        f"`http://localhost:{dev_port}` を使う\n"
        "2. 確認した画面・操作手順と**そのURLをそのまま**ユーザーに提示し、問題ないか"
        "明示的な承認を得る（ユーザーは外出先のスマホから開くため、`localhost`のURLでは"
        "届かない）。**承認可否は`AskUserQuestion`で尋ねること。** そうするとフックが自動で"
        "`00.check-user`を付け、issue-deckの画面の「ユーザーの確認待ち」に出ます"
        "（答えた時点で自動的に外れます。#1417）\n"
        "3. 承認が得られてから初めてPRを作成する。PR本文の「確認方法」にも同じURLを書く"
    )

if "24.screenshot-required" in label_names:
    screenshot_instructions = (
        "このIssueには`24.screenshot-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に変更箇所のスクリーンショットを取得し、ユーザーの承認を得てから"
        "PRを作成してください（新規依存関係の追加が必要な場合は、追加前に必ず確認する）。"
        "**承認可否は`AskUserQuestion`で尋ねること。** そうするとフックが自動で`00.check-user`を付け、"
        "issue-deckの画面の「ユーザーの確認待ち」に出ます（答えた時点で自動的に外れます。#1417）"
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
# **同じ文面が scripts/start-issue.sh と
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

# Pull Requestの作り方（#2499）。一覧は scripts/local-repo-pr-policy.conf で、判定はシェル側
# （scripts/lib/pr-policy.sh）が済ませて`pr_policy`として渡ってくる。
#
# **`{{BASE_BRANCH}}`・`{{ISSUE_NUMBER}}`をこの文面に残さないこと。** 差し込みは
# `replacements`を1つずつ置換していく形で、後から入った値の中のプレースホルダが置換される
# かどうかは辞書の並び順に依存する。ここで実値を埋めておけば並び順に左右されない。
#
# **同じ文面が src/lib/prompts/pr-policy.ts にもある**（画面の「実装プロンプトをコピー」用。
# ブラウザからconfは読めないため一覧ごと写しで持つ）。変えるときは両方そろえる。
if pr_policy == "manual":
    pr_policy_instructions = (
        f"- **Pull Requestは、ユーザーから指示されるまで作りません。** このリポジトリ"
        f"（`{repository}`）は、成果物を一度で仕上げるのではなく同じセッションで何度も"
        f"練り直す使い方をします。コミットとpush（`issue-{issue['number']}`ブランチ）は"
        "いつでも行ってよいですが、`gh pr create`は「PRを作って」と言われてから実行します\n"
        "- **`11.local`もPull Requestを作るまで外しません。** 外すと「ローカル作業を終えた」と"
        "判定され、数分でこのセッションが自動終了します（`scripts/reap-sessions.sh`）。"
        "PRを作らない限り畳まれないので、続きは同じ会話でやり取りできます\n"
        "- 一区切りついたら、Pull Requestを作る代わりに**どこまで進んだかをIssueコメントへ"
        "残し**、次に何をするかを`AskUserQuestion`でユーザーへ尋ねます（フックが"
        "`00.check-user`と`01.check-input`を付け、issue-deckのPush通知が飛びます。"
        "答えた時点で外れます）\n"
        "- **後述の「完了報告」は、PRを作らない回でも省きません。** 「作成したPull Requestの"
        "URL」の代わりに「どこまで進んだか・次に何をするか」を書いて投稿します。報告が無いと、"
        "issue-deckの画面からは進んだのか止まったのか分かりません（同じ理由で、一区切りの前に"
        f"`gh issue view {issue['number']} --repo {repository} --comments`で最新の指示を"
        "確認するのも、PRの有無によらず行います）\n"
        f"- 指示を受けてPull Requestを作るときは`{base_branch or '(判定できませんでした)'}`"
        "向けに作成し（本文に対応Issue・実装内容・テスト内容・確認方法・注意点を記載）、"
        "マージ時点ではissueをcloseしない運用のため`closes #番号`/`fixes #番号`は使わず"
        f"`#{issue['number']}`のように番号のみ記載します。作成したら`11.local`を外します"
    )
else:
    pr_policy_instructions = (
        f"- `{base_branch or '(判定できませんでした)'}` 向けPull Requestを作成する"
        "（本文に対応Issue・実装内容・テスト内容・確認方法・注意点を記載）。マージ時点では"
        "issueをcloseしない運用のため、PR本文に`closes #番号`/`fixes #番号`は使わず、"
        f"`#{issue['number']}`のように番号のみ記載する\n"
        "- Pull Requestを作成してレビューへ渡し、ローカルでの作業を終える時点で`11.local`を"
        "外す。付けたままだと、無人実行（`claude-issue-dispatch.yml`を持つリポジトリの場合）が"
        "このIssueへの追加対応を一切行えない。ローカルで作業を続けている間は付けたままにする"
    )

# 全アプリ共通の共有知識（#1741）。**実装対象が共有知識リポジトリ自身のときは文面ごと差し替える。**
# 既定の文面は「共有知識は読み取り専用」と書いており、そのリポジトリを実装する回では指示が
# 自己矛盾する。あわせて`--add-dir`も付けていない（本体チェックアウトを渡すと、worktreeではなく
# そちらを編集する事故を招くため）。
if skip_shared_context == "1":
    shared_context_instructions = (
        f"**このリポジトリ自身が全アプリ共通の共有知識リポジトリです**（`{shared_context_dir}` = "
        f"`{repository}`）。そのため、他のリポジトリのセッションで付く共有知識の参照"
        "（`--add-dir`）はこのセッションには付いていません。読むのも書くのも、"
        f"**このセッションのworktree（`{worktree_dir}`）の中のファイル**です。\n\n"
        f"- `{shared_context_dir}` は同じリポジトリの**本体チェックアウト**で、"
        "他の全セッションが実行中に読んでいます。**絶対に編集しないでください**"
        "（そこを汚すと、走っている他のセッションの前提まで変わります）\n"
        "- 索引は worktree 内の `CLAUDE.md`、実装エージェント向けの共通ルールは "
        "`agent-rules/implementation.md` です。**自分のworktree側を読んでください**\n"
        "- 後述「実装中に得た知見の記録」にある「共有知識リポジトリへ反映できません」は、"
        "**実装対象がこのリポジトリ自身である今回は当てはまりません**。共通の知見はこのPull Requestに"
        "同梱して構いません（ただしIssueの要求から外れる変更は入れないこと）"
    )
else:
    shared_context_instructions = (
        f"このセッションでは `--add-dir` により共有知識リポジトリ（`{shared_context_dir}` = "
        "`guchi-apps/docs`）を参照できます（存在しない環境では付与されません）。"
        "実装の前提として、必要な範囲だけ読んでください。\n\n"
        f"- `{shared_context_dir}/CLAUDE.md` — 共有知識の索引・読む順序\n"
        f"- `{shared_context_dir}/agent-rules/implementation.md` — 実装エージェントの共通ルール\n"
        f"- `{shared_context_dir}/knowledge/` — 今回触る領域（GitHub Actions・デプロイ・認証・DB等）に"
        "対応するファイルがあれば着手前に読む\n\n"
        "共有知識リポジトリのファイルは**読み取り専用**として扱い、編集・コミットは行わないでください。"
        "内容が対象リポジトリの `CLAUDE.md` / `docs/` と矛盾する場合は、対象リポジトリ側を優先します。"
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

replacements = {
    "{{ISSUE_NUMBER}}": str(issue["number"]),
    "{{ISSUE_TITLE}}": issue["title"],
    "{{ISSUE_LABELS}}": labels,
    "{{ISSUE_BODY}}": issue.get("body") or "(本文なし)",
    "{{ISSUE_COMMENTS}}": comment_text,
    "{{ISSUE_RELATIONS}}": issue_relations or "（取得できませんでした）",
    "{{CONCURRENT_WORK}}": concurrent_work or "（取得できませんでした）",
    "{{REPOSITORY}}": repository,
    "{{WORKTREE_DIR}}": worktree_dir,
    "{{BASE_BRANCH}}": base_branch or "(判定できませんでした)",
    "{{PACKAGE_MANAGER}}": package_manager or "(なし)",
    "{{DEV_COMMAND}}": dev_command,
    "{{DEV_PORT}}": dev_port,
    "{{PREVIEW_INSTRUCTIONS}}": preview_instructions,
    "{{SCREENSHOT_INSTRUCTIONS}}": screenshot_instructions,
    "{{ARTIFACT_INSTRUCTIONS}}": artifact_instructions,
    "{{PR_POLICY_INSTRUCTIONS}}": pr_policy_instructions,
    "{{SHARED_CONTEXT_INSTRUCTIONS}}": shared_context_instructions,
}
result = template
for placeholder, value in replacements.items():
    result = result.replace(placeholder, value)
sys.stdout.write(result)
PY
rm -f "$ISSUE_JSON_FILE"

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  echo "#$ISSUE_NUMBER: 準備が完了しました。"
  echo "  worktree: $WORKTREE_DIR"
  echo "  プロンプト: $PROMPT_FILE"
  echo "  開発サーバー用ポート: $DEV_PORT（未起動）"
  exit 0
fi

# --- セッションの起動 ---------------------------------------------------------
# 出口はtmuxがあるかどうかだけで決まる（#1178）。セッション名は`<リポジトリ名>-issue-<番号>`で、
# **pollerが起動前後のtmuxセッション一覧の差分で成否を見る**ため、ここで名前を変えない。
SAFE_REPO="${REPO//[^A-Za-z0-9_-]/-}"
SESSION_NAME="$SAFE_REPO-issue-$ISSUE_NUMBER"

# 開発サーバーを起動するか（#1224・#1265）。
#
# **既定は起動しない。** サブPCの実効RAMは13Giで、リポジトリ数ぶんのdevサーバーを常駐させる
# 前提が置けない（#1523。CPUの載せ替えでは変わらない・#1791）。ただし`23.preview-required`は
# 「PR作成前に画面を確認する」ラベルで、
# 起動していなければ確認そのものが成立しない。**そのラベルが付いたセッションだけ起動し、
# tailnetへも出す**（#1265）。
DEV_SERVER_FLAG=0
if printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "23.preview-required"; then
  DEV_SERVER_FLAG=1
  echo "#$ISSUE_NUMBER: 23.preview-required が付いているため開発サーバーを起動します（tailnetへも公開します）。"
fi

# tmuxのセッションはtmuxサーバー側の環境を引き継ぐため、このプロセスのexportが届くとは限らない。
# 値は%qでクォートして埋める。
build_env_prefix() {
  local var value prefix=""
  prefix+="export ISSUE_DECK_DEV_SERVER=$DEV_SERVER_FLAG; "
  prefix+="export ISSUE_DECK_WORKTREE_BASE=$(printf '%q' "$WORKTREE_BASE"); "
  prefix+="export ISSUE_DECK_DEV_COMMAND=$(printf '%q' "$DEV_COMMAND"); "
  # ISSUE_DECK_SESSION_REAPABLE / ISSUE_DECK_SESSION_STATE_DIR はセッションの自動回収（#1256）用。
  # 前者はpollerがジョブとして起動した経路でだけ渡ってくる印で、tmuxの中まで届かないと
  # 記述子に載らず、回収の対象にならない。
  # ISSUE_DECK_CLAUDE_RESUME は前回の会話を引き継ぐかどうか（#1541）。worktreeの扱いを見て
  # 上で決めた値で、tmuxの中まで届かないと新規worktreeでも再開してしまう。
  # ISSUE_DECK_SKIP_SHARED_CONTEXT は実装対象が共有知識リポジトリ自身かどうか（#1741）。
  # tmuxの中まで届かないと `--add-dir` が付いてしまい、本体チェックアウトを渡すことになる。
  for var in ISSUE_DECK_SHARED_CONTEXT_DIR ISSUE_DECK_SKIP_SHARED_CONTEXT \
    ISSUE_DECK_CLAUDE_PERMISSION_MODE \
    ISSUE_DECK_SESSION_REAPABLE ISSUE_DECK_SESSION_STATE_DIR ISSUE_DECK_CLAUDE_RESUME; do
    value="${!var:-}"
    [[ -n "$value" ]] || continue
    prefix+="export $var=$(printf '%q' "$value"); "
  done
  # 同期コピーから起動した場合の情報（#1438）。run-issue-session.sh は自分の置き場所しか
  # 知らないため、本体の作業ツリーの場所とあわせてここから渡す
  if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
    prefix+="export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA=$(printf '%q' "$LAUNCHER_SCRIPTS_SHA"); "
    prefix+="export ISSUE_DECK_LAUNCHER_ROOT=$(printf '%q' "$ROOT"); "
  fi
  printf '%s' "$prefix"
}

SESSION_CMD="$(printf "%scd %q && bash %q %q %q %q" "$(build_env_prefix)" "$WORKTREE_DIR" \
  "$LAUNCHER_SCRIPTS_DIR/run-issue-session.sh" "$ISSUE_NUMBER" "$DEV_PORT" "$PROMPT_FILE")"

if [[ "$TMUX_MODE" == "classic" ]] || ! command -v tmux >/dev/null 2>&1; then
  if [[ "$TMUX_MODE" != "classic" ]]; then
    echo "警告: tmux が見つからないため、このターミナルで起動します（切断するとセッションも終了します）。" >&2
  fi
  cd "$WORKTREE_DIR"
  exec bash -lc "$SESSION_CMD"
fi

# 同名のセッションが動いていれば作らない。`remain-on-exit`で残った「死んだペインだけの
# セッション」は前回の終了の痕跡なので、最後の出力を見せてから畳んで作り直す（#1177・#1178）。
if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
  ALIVE_PANES="$(tmux list-panes -s -t "=$SESSION_NAME" -F '#{pane_dead}' 2>/dev/null | grep -cv '^1$' || true)"
  if [[ "${ALIVE_PANES:-0}" -eq 0 ]]; then
    echo "#$ISSUE_NUMBER: 前回のtmuxセッション「$SESSION_NAME」は終了したまま残っていました。最後の出力:"
    tmux capture-pane -p -t "$SESSION_NAME:" 2>/dev/null | grep -v '^$' | tail -n 15 | sed 's/^/    /' || true
    tmux kill-session -t "=$SESSION_NAME" >/dev/null 2>&1 || true
  else
    echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」は既に動いています。新しくは起動しません。"
    exit 0
  fi
fi

echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」でClaude Codeセッションを起動します..."
# tmuxはコマンドを既定シェルで直接実行し、**ログインシェルとしては起動しない**。`~/.profile`系が
# 読まれずPATHに`~/.local/bin`が乗らないため、そのままではclaudeが見つからず即死する（#1177）。
if ! tmux new-session -d -s "$SESSION_NAME" -c "$WORKTREE_DIR" "bash -lc $(printf '%q' "$SESSION_CMD")"; then
  echo "Error: tmuxセッション「$SESSION_NAME」の起動に失敗しました。" >&2
  exit 1
fi

# 異常終了時にペインを残す。既定ではコマンドの終了と同時にセッションごと消えるため、
# **エラーメッセージが一切残らない**（#1177）。`failed`はtmux 3.2以降。古いtmuxでは`on`へ落とす。
tmux set-option -t "$SESSION_NAME:" -w remain-on-exit failed >/dev/null 2>&1 ||
  tmux set-option -t "$SESSION_NAME:" -w remain-on-exit on >/dev/null 2>&1 || true

echo
echo "起動したセッションはこのターミナルを閉じても（SSHが切れても）動き続けます。"
if [[ -n "${TMUX:-}" ]]; then
  echo "  tmux switch-client -t $SESSION_NAME"
elif [[ -t 0 && -t 1 ]]; then
  echo "アタッチします（切り離すには Ctrl-b d）..."
  exec tmux attach-session -t "=$SESSION_NAME"
else
  echo "  tmux attach -t $SESSION_NAME"
fi
