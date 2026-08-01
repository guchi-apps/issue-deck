#!/usr/bin/env bash
# Issueごとに専用ブランチ・git worktreeを作成し、実装エージェント用のClaude Codeセッションを起動する
#
# 使い方:
#   scripts/start-issue.sh <issue番号> [issue番号...]
#
# 前提:
#   - gh コマンドで認証済みであること
#   - pnpm install 済み（本体の node_modules は使わず、worktreeごとに個別インストールする）
#
# 本体リポジトリの作業ツリー（ブランチ・uncommitted changes）には一切触れない。
# develop の最新化は git fetch のみで行い、git worktree add で新しいブランチ・作業ディレクトリを作る。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
PROMPT_TEMPLATE="$ROOT/scripts/prompts/implementation-agent.md"
PROMPT_DIR="$WORKTREE_BASE/.prompts"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/start-issue.sh <issue番号> [issue番号...]" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh コマンドが見つかりません。" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude コマンドが見つかりません。" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: $PROMPT_TEMPLATE がありません。" >&2
  exit 1
fi

for n in "$@"; do
  if [[ ! "$n" =~ ^[0-9]+$ ]]; then
    echo "Error: issue番号は数字で指定してください: $n" >&2
    exit 1
  fi
done

mkdir -p "$PROMPT_DIR"

# issue番号ごとにworktree・ブランチを準備し、起動用プロンプトを生成する。
# 戻り値として WORKTREE_DIR / PROMPT_FILE をグローバル変数に設定する。
prepare_issue() {
  local n="$1"
  WORKTREE_DIR="$WORKTREE_BASE/issue-$n"
  PROMPT_FILE="$PROMPT_DIR/issue-$n.md"

  if [[ -e "$WORKTREE_DIR" ]]; then
    echo "Error: $WORKTREE_DIR は既に存在します（issue #$n は起動済みの可能性があります）。" >&2
    exit 1
  fi

  echo "#$n: Issue内容を取得しています..."
  local issue_json
  if ! issue_json="$(gh issue view "$n" --repo m-guchi/issue-deck --json number,title,body,labels,comments)"; then
    echo "Error: issue #$n の取得に失敗しました。" >&2
    exit 1
  fi

  echo "#$n: develop を最新化しています..."
  git -C "$ROOT" fetch origin develop

  echo "#$n: worktree・ブランチ issue-$n を作成しています..."
  if ! git -C "$ROOT" worktree add "$WORKTREE_DIR" -b "issue-$n" origin/develop; then
    echo "Error: worktree/ブランチの作成に失敗しました（ブランチ issue-$n が既に存在する可能性があります）。" >&2
    exit 1
  fi

  if [[ -f "$ROOT/.env.local" ]]; then
    cp "$ROOT/.env.local" "$WORKTREE_DIR/.env.local"
  else
    echo "警告: $ROOT/.env.local が無いため .env.local をコピーしませんでした。" >&2
  fi

  echo "#$n: pnpm install しています..."
  (cd "$WORKTREE_DIR" && pnpm install)

  echo "#$n: 起動用プロンプトを生成しています..."
  local issue_json_file
  issue_json_file="$(mktemp)"
  printf '%s' "$issue_json" >"$issue_json_file"
  python3 - "$issue_json_file" "$PROMPT_TEMPLATE" >"$PROMPT_FILE" <<'PY'
import json
import sys

issue_json_path, template_path = sys.argv[1], sys.argv[2]

with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

labels = ", ".join(l["name"] for l in issue.get("labels", [])) or "(なし)"

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
)
sys.stdout.write(result)
PY
  rm -f "$issue_json_file"
}

# 単一worktree内でclaudeを起動するコマンド文字列を作る（PROMPT_FILEのパスのみを埋め込み、
# Issue本文・コメントなどの外部由来テキストはコマンド文字列に直接展開しない）。
build_claude_cmd() {
  local worktree_dir="$1"
  local prompt_file="$2"
  printf "cd %q && claude --permission-mode acceptEdits \"\$(cat %q)\"" "$worktree_dir" "$prompt_file"
}

if [[ $# -eq 1 ]]; then
  n="$1"
  prepare_issue "$n"
  echo "#$n: Claude Codeセッションを起動します（このターミナルで実行）..."
  cd "$WORKTREE_DIR"
  PROMPT_CONTENT="$(cat "$PROMPT_FILE")"
  exec claude --permission-mode acceptEdits "$PROMPT_CONTENT"
fi

# 複数issue指定時は、それぞれ独立したセッションを同時に使うため新しいWindows Terminalタブで起動する。
WT_AVAILABLE=0
if command -v wt.exe >/dev/null 2>&1; then
  WT_AVAILABLE=1
fi
DISTRO="${WSL_DISTRO_NAME:-}"

for n in "$@"; do
  prepare_issue "$n"
  if [[ "$WT_AVAILABLE" -eq 1 && -n "$DISTRO" ]]; then
    echo "#$n: 新しいWindows Terminalタブでセッションを起動します..."
    cmd="$(build_claude_cmd "$WORKTREE_DIR" "$PROMPT_FILE")"
    wt.exe -w 0 new-tab --title "issue-$n" -- wsl.exe -d "$DISTRO" -- bash -lc "$cmd"
  else
    echo "#$n: worktreeの準備ができました。以下を手動で実行してください:"
    echo "  cd \"$WORKTREE_DIR\" && claude --permission-mode acceptEdits \"\$(cat \"$PROMPT_FILE\")\""
  fi
done
