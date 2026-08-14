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
#   ポート帯              scripts/local-repo-ports.conf
#   プロンプト            対象リポジトリの scripts/prompts/implementation-agent.md があればそれ、
#                         無ければ scripts/prompts/generic-implementation-agent.md
#   上記で吸収できない事情 対象リポジトリの scripts/issue-session-hooks.sh（任意）
#
# **開発サーバーは既定で起動しない。** サブPCは2C/4T（同時実行の既定が2なのもこの実測による・
# #1177）で、リポジトリ数ぶんのdevサーバーを常駐させる前提が置けない。ポートは env に書き込む
# ので、必要なセッションだけ中で起動する。
#
# 環境変数:
#   ISSUE_DECK_DEV_PORT_BASE            開発サーバーのポートのベース値（受け口が渡す）
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

# worktreeを作ってから落ちると中途半端な状態が残るため、パッケージマネージャの有無は先に確かめる。
PACKAGE_MANAGER="$(detect_package_manager "$REPO_PATH")"
if [[ -n "$PACKAGE_MANAGER" ]] && ! command -v "$PACKAGE_MANAGER" >/dev/null 2>&1; then
  echo "Error: $FULL_NAME が必要とする $PACKAGE_MANAGER が見つかりません。" >&2
  echo "  nvmを使っている場合、非対話シェルでは ~/.bashrc が読まれません（#1085）。" >&2
  exit 1
fi

WORKTREE_BASE="${ISSUE_DECK_GENERIC_WORKTREE_BASE:-$HOME/apps/$REPO-worktrees}"
PROMPT_DIR="$WORKTREE_BASE/.prompts"
WORKTREE_DIR="$WORKTREE_BASE/issue-$ISSUE_NUMBER"
PROMPT_FILE="$PROMPT_DIR/issue-$ISSUE_NUMBER.md"
BRANCH="issue-$ISSUE_NUMBER"
DEV_PORT=$(( ${ISSUE_DECK_DEV_PORT_BASE:-3000} + ISSUE_NUMBER ))

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

# envファイルから1つのキーの値を読む（存在しなければ空文字）。値はログに出さない。
read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n1 | sed -e 's/^"//' -e 's/"$//'
}

# 進捗報告APIの宛先と鍵。issue-deck本体の`.env.local`を第一候補にし、無ければサブPCの
# ディスパッチ設定（`~/.config/issue-deck/dispatch.env`）から読む。**サブPCには issue-deck の
# `.env.local` が無いことがある**（アプリ自体はVPSで動いており、手元は起動用のcloneに過ぎない）。
resolve_progress_endpoint() {
  local dispatch_env="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
  PROGRESS_BASE_URL="$(read_env_value "$ROOT/.env.local" APP_BASE_URL)"
  PROGRESS_SECRET="$(read_env_value "$ROOT/.env.local" PROGRESS_REPORT_SECRET)"
  [[ -n "$PROGRESS_BASE_URL" ]] || PROGRESS_BASE_URL="$(read_env_value "$dispatch_env" APP_BASE_URL)"
  [[ -n "$PROGRESS_SECRET" ]] || PROGRESS_SECRET="$(read_env_value "$dispatch_env" PROGRESS_REPORT_SECRET)"
  PROGRESS_BASE_URL="${PROGRESS_BASE_URL%/}"
}

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

# 起動時にIssueの進捗（Project Status）を報告する（#1096）。
# **既に進捗が始まっている場合は触らない**（再開で`Develop PR`まで進んだIssueを巻き戻さない）。
report_start_progress() {
  local desired current code
  resolve_progress_endpoint
  if [[ -z "$PROGRESS_BASE_URL" || -z "$PROGRESS_SECRET" ]]; then
    echo "#$ISSUE_NUMBER: 進捗（Project Status）は報告しませんでした（APP_BASE_URL / PROGRESS_REPORT_SECRET が見つかりません）。"
    echo "     issue-deckの画面の「実装を開始」ボタン、またはカンバンでカードを動かして進捗を進めてください。"
    return 0
  fi

  current="$(curl -sS -m 20 -H "Authorization: Bearer $PROGRESS_SECRET" \
    "$PROGRESS_BASE_URL/api/progress?repository=$FULL_NAME&issue=$ISSUE_NUMBER" 2>/dev/null |
    jq -r 'select(.available == true) | .status // empty' 2>/dev/null || true)"
  if [[ -n "$current" && "$current" != "ready" ]]; then
    echo "#$ISSUE_NUMBER: 進捗は既に開始済みです（$current）。巻き戻さないため報告しません。"
    return 0
  fi

  if printf '%s\n' "$ISSUE_LABELS" | grep -Fxq "21.plan-required"; then
    desired="planning"
  else
    desired="implementation"
  fi

  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
    -X POST "$PROGRESS_BASE_URL/api/progress" \
    -H "Authorization: Bearer $PROGRESS_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"repository\":\"$FULL_NAME\",\"issue\":$ISSUE_NUMBER,\"status\":\"$desired\"}" 2>/dev/null)" || code=000
  if [[ "$code" == "200" ]]; then
    echo "#$ISSUE_NUMBER: 進捗を $desired として報告しました。"
  else
    echo "#$ISSUE_NUMBER: 警告: 進捗（$desired）の報告に失敗しました（HTTP $code）。issue-deckの画面から進めてください。" >&2
  fi
}

if [[ "$SKIP_START_REPORT" -eq 0 ]]; then
  apply_start_labels
  report_start_progress
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
    echo "#$ISSUE_NUMBER: 　　　 作り直す場合は worktree を削除してから再実行してください（scripts/cleanup-worktrees.sh 相当の掃除は各リポジトリで行う）。" >&2
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

# --- envファイル --------------------------------------------------------------
# 本体チェックアウトの .env.local / .env をworktreeへ供給する。再開時は既存を尊重し、
# 不足キーだけを補う（#1099）。どちらも無いリポジトリでは何もしない。
supply_env_files "$ISSUE_NUMBER" "$REPO_PATH" "$WORKTREE_DIR" .env.local .env

# 開発サーバーのポートをIssueごとに一意にする（同じマシンで複数worktree・複数リポジトリの
# セッションが並ぶため）。**帯はissue-deck側の対応表が持つ**（scripts/local-repo-ports.conf）。
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
  PROMPT_TEMPLATE="$SCRIPT_DIR/prompts/generic-implementation-agent.md"
  PROMPT_TEMPLATE_SOURCE="issue-deckの汎用テンプレート"
fi
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: プロンプトのテンプレートがありません（$PROMPT_TEMPLATE）。" >&2
  exit 1
fi

echo "#$ISSUE_NUMBER: 起動用プロンプトを生成しています（$PROMPT_TEMPLATE_SOURCE）..."
DEV_COMMAND="${PACKAGE_MANAGER:-npm} run dev"
if [[ "$PACKAGE_MANAGER" == "pnpm" || "$PACKAGE_MANAGER" == "bun" ]]; then
  DEV_COMMAND="$PACKAGE_MANAGER dev"
fi

ISSUE_JSON_FILE="$(mktemp)"
printf '%s' "$ISSUE_JSON" >"$ISSUE_JSON_FILE"
python3 - "$ISSUE_JSON_FILE" "$PROMPT_TEMPLATE" "$FULL_NAME" "$WORKTREE_DIR" "${BASE_BRANCH:-}" \
  "$PACKAGE_MANAGER" "$DEV_COMMAND" "$DEV_PORT" >"$PROMPT_FILE" <<'PY'
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
) = sys.argv[1:9]

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
    preview_instructions = (
        "このIssueには`23.preview-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に次の手順を行ってください。\n\n"
        f"1. `cd {worktree_dir} && {dev_command}` で開発サーバーを起動し、"
        f"`http://localhost:{dev_port}` で実際の画面を確認する\n"
        "2. 確認した画面・操作手順をユーザーに提示し、問題ないか明示的な承認を得る\n"
        "3. 承認が得られてから初めてPRを作成する"
    )

if "24.screenshot-required" in label_names:
    screenshot_instructions = (
        "このIssueには`24.screenshot-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に変更箇所のスクリーンショットを取得し、ユーザーの承認を得てから"
        "PRを作成してください（新規依存関係の追加が必要な場合は、追加前に必ず確認する）。"
    )
else:
    screenshot_instructions = (
        "このIssueには`24.screenshot-required`ラベルが付いていないため、"
        "Playwright等によるスクリーンショットの自動取得は不要です（トークン消費が大きいため）。"
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
    "{{REPOSITORY}}": repository,
    "{{WORKTREE_DIR}}": worktree_dir,
    "{{BASE_BRANCH}}": base_branch or "(判定できませんでした)",
    "{{PACKAGE_MANAGER}}": package_manager or "(なし)",
    "{{DEV_COMMAND}}": dev_command,
    "{{DEV_PORT}}": dev_port,
    "{{PREVIEW_INSTRUCTIONS}}": preview_instructions,
    "{{SCREENSHOT_INSTRUCTIONS}}": screenshot_instructions,
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

# tmuxのセッションはtmuxサーバー側の環境を引き継ぐため、このプロセスのexportが届くとは限らない。
# 値は%qでクォートして埋める。**開発サーバーは起動しない**ので ISSUE_DECK_DEV_SERVER=0 を渡す。
build_env_prefix() {
  local var value prefix=""
  prefix+="export ISSUE_DECK_DEV_SERVER=0; "
  prefix+="export ISSUE_DECK_WORKTREE_BASE=$(printf '%q' "$WORKTREE_BASE"); "
  prefix+="export ISSUE_DECK_DEV_COMMAND=$(printf '%q' "$DEV_COMMAND"); "
  for var in ISSUE_DECK_SHARED_CONTEXT_DIR ISSUE_DECK_CLAUDE_PERMISSION_MODE; do
    value="${!var:-}"
    [[ -n "$value" ]] || continue
    prefix+="export $var=$(printf '%q' "$value"); "
  done
  printf '%s' "$prefix"
}

SESSION_CMD="$(printf "%scd %q && bash %q %q %q %q" "$(build_env_prefix)" "$WORKTREE_DIR" \
  "$SCRIPT_DIR/run-issue-session.sh" "$ISSUE_NUMBER" "$DEV_PORT" "$PROMPT_FILE")"

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
