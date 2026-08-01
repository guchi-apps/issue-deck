#!/usr/bin/env bash
# develop向けの未処理PR一覧を把握した状態で、レビュー・統合エージェント用のClaude Codeセッションを起動する
#
# 使い方:
#   scripts/start-reviewer.sh
#
# 前提:
#   - gh コマンドで認証済みであること
#   - 本体リポジトリ（このスクリプトがあるリポジトリ）はdevelopの最新チェックアウトとして空けておく運用
#
# 実装エージェント側（start-issue.sh）と異なり、レビュー・統合エージェントは常に本体リポジトリで
# 動作し、PRを1件ずつ gh pr checkout しながら処理する。worktreeは作成しない。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPT_TEMPLATE="$ROOT/scripts/prompts/review-agent.md"

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

cd "$ROOT"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Error: 本体リポジトリの作業ツリーに未コミットの変更があります。レビュー・統合エージェントはdevelopの綺麗な状態を前提とするため、先にコミット/stashしてください。" >&2
  exit 1
fi

echo "develop を最新化しています..."
git checkout develop
git pull --ff-only origin develop

echo "未処理PR一覧を取得しています..."
PR_JSON_FILE="$(mktemp)"
trap 'rm -f "$PR_JSON_FILE" "${PR_LIST_FILE:-}"' EXIT
gh pr list --repo m-guchi/issue-deck --base develop --json number,title,author,headRefName,mergeable,statusCheckRollup,url >"$PR_JSON_FILE"

PR_LIST_FILE="$(mktemp)"
python3 - "$PR_JSON_FILE" >"$PR_LIST_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as f:
    prs = json.load(f)

if not prs:
    print("現在レビュー待ちのPRはありません。")
else:
    def ci_state(pr):
        # statusCheckRollupの要素はCheckRun（status/conclusion）とStatusContext（state）の
        # 2種類が混在しうるため、いずれのフィールドからも状態を拾う。
        checks = pr.get("statusCheckRollup") or []
        if not checks:
            return "NONE"
        states = set()
        for c in checks:
            conclusion = c.get("conclusion")
            status = c.get("status")
            state = c.get("state")
            if conclusion:
                states.add(conclusion.upper())
            elif status and status.upper() != "COMPLETED":
                states.add(status.upper())
            elif state:
                states.add(state.upper())
            else:
                states.add("UNKNOWN")
        if states & {"FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"}:
            return "FAILURE"
        if states & {"PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"}:
            return "PENDING"
        if states <= {"SUCCESS", "NEUTRAL", "SKIPPED"}:
            return "SUCCESS"
        return "/".join(sorted(states))

    for pr in prs:
        print(
            "- #{number} {title}\n"
            "  branch: {branch} / author: {author} / mergeable: {mergeable} / CI: {ci}\n"
            "  {url}".format(
                number=pr["number"],
                title=pr["title"],
                branch=pr["headRefName"],
                author=(pr.get("author") or {}).get("login", "unknown"),
                mergeable=pr.get("mergeable", "UNKNOWN"),
                ci=ci_state(pr),
                url=pr["url"],
            )
        )
PY

cat "$PR_LIST_FILE"
echo

PROMPT_CONTENT="$(python3 - "$PROMPT_TEMPLATE" "$PR_LIST_FILE" <<'PY'
import sys

template_path, pr_list_path = sys.argv[1], sys.argv[2]

with open(template_path, encoding="utf-8") as f:
    template = f.read()
with open(pr_list_path, encoding="utf-8") as f:
    pr_list = f.read()

sys.stdout.write(template.replace("{{PR_LIST}}", pr_list))
PY
)"

echo "Claude Codeセッションを起動します（このターミナルで実行）..."
exec claude --permission-mode acceptEdits "$PROMPT_CONTENT"
