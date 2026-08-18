#!/usr/bin/env bash
# レビューのClaude Codeセッションを起動する。関門（gate）ごとに2つの役がある。
#
# 使い方:
#   scripts/start-reviewer.sh                成果物の関門（G2）。develop向けの未処理PRを見てマージする
#   scripts/start-reviewer.sh --plan <番号>  計画の関門（G1）。Issueの計画をリポジトリの実態と突き合わせる
#
# 前提:
#   - gh コマンドで認証済みであること
#   - 本体リポジトリ（このスクリプトがあるリポジトリ）はdevelopの最新チェックアウトとして空けておく運用
#
# 実装エージェント側（start-issue.sh）と異なり、どちらの役も常に本体リポジトリで動作する。
# G2はPRを1件ずつ gh pr checkout しながら処理し、G1は読むだけ。worktreeは作成しない。
#
# **G1とG2はセッションを兼ねない**（#1218・docs/multi-agent/gates.md）。マージ権限を持つ
# セッションが計画へ指摘すると、自分が指示したとおりに実装されたPRを自分でマージする自己承認の
# 構図になるため、入口とプロンプトを分けている。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="pr"
PLAN_ISSUE=""

usage() {
  sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      MODE="plan"
      PLAN_ISSUE="${2:-}"
      shift 2 || true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Error: 不明な引数です: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$MODE" == "plan" ]]; then
  if [[ ! "$PLAN_ISSUE" =~ ^[0-9]+$ ]]; then
    echo "Error: --plan にはIssue番号を指定してください（例: scripts/start-reviewer.sh --plan 1218）。" >&2
    exit 1
  fi
  PROMPT_TEMPLATE="$ROOT/scripts/prompts/plan-review-agent.md"
else
  PROMPT_TEMPLATE="$ROOT/scripts/prompts/review-agent.md"
fi

# セッションの出力言語（#1395）。実装セッション（scripts/run-issue-session.sh）と共有する。
# shellcheck source=scripts/lib/agent-language.sh
source "$ROOT/scripts/lib/agent-language.sh"
# 計画レビューのプロンプトの組み立て（#1855）。自動の入口（start-plan-review.sh）と共有する。
# shellcheck source=scripts/lib/plan-review-prompt.sh
source "$ROOT/scripts/lib/plan-review-prompt.sh"
# APIの一時的な過負荷（529）で打ち切られにくくする（#1971）。実装セッションと同じ値を使う。
# shellcheck source=scripts/lib/claude-retries.sh
source "$ROOT/scripts/lib/claude-retries.sh"

# このスクリプトが見るリポジトリ。G2のPR一覧の取得先と、G1のプロンプトへ埋める`{{REPOSITORY}}`。
REVIEW_REPO="${ISSUE_DECK_REPO:-guchi-apps/issue-deck}"

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

trap 'rm -f "${PR_JSON_FILE:-}" "${PR_LIST_FILE:-}" "${FLEET_STATUS_FILE:-}"' EXIT

if [[ "$MODE" == "plan" ]]; then
  # 計画の関門（G1・#1218）。並行状況スナップショット（#1215）をプロンプトへ差し込む。
  # 直前にdevelopを最新化しているので --no-fetch でよい。
  # **取れなくてもレビュー自体は行う**（俯瞰は材料の1つであって必須ではない）。
  #
  # **差し込みは`scripts/lib/plan-review-prompt.sh`と共有する**（#1855）。自動の入口
  # （`scripts/start-plan-review.sh`）と同じ文面・同じプレースホルダで渡すため。
  echo "並行状況を取得しています..."
  FLEET_STATUS_FILE="$(mktemp)"
  plan_review_fleet_status "$ROOT/scripts/fleet-status.sh" "$ROOT" "$REVIEW_REPO" \
    >"$FLEET_STATUS_FILE"
  cat "$FLEET_STATUS_FILE"
  echo

  # 人が起動する入口では、読むのは本体チェックアウト（直前に`git pull`済み）。
  PROMPT_CONTENT="$(plan_review_render_prompt "$PROMPT_TEMPLATE" "$PLAN_ISSUE" "$REVIEW_REPO" \
    "$ROOT" "本体チェックアウト・developの最新" "$FLEET_STATUS_FILE")"

  echo "Issue #$PLAN_ISSUE の計画レビュー（G1）としてClaude Codeセッションを起動します。"
else
# 以下は従来どおりの成果物の関門（G2）。ヒアドキュメントを含むため、条件分岐を足しても
# インデントは変えていない。
echo "未処理PR一覧を取得しています..."
PR_JSON_FILE="$(mktemp)"
gh pr list --repo "$REVIEW_REPO" --base develop --json number,title,author,headRefName,mergeable,statusCheckRollup,url >"$PR_JSON_FILE"

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
fi

# 全アプリ共通の共有知識リポジトリ（guchi-apps/docs）をローカルにcloneしてある場合は、
# --add-dir でリポジトリ外のそのディレクトリも参照できるようにする（docs/shared-knowledge.md
# 「8. Claude Codeへのコンテキストの渡し方」）。cloneしていない環境でも起動できるよう、
# 存在しない場合は --add-dir を付けずにそのまま起動する。
SHARED_CONTEXT_DIR="${ISSUE_DECK_SHARED_CONTEXT_DIR:-$HOME/apps/_docs}"
CLAUDE_EXTRA_ARGS=()
if [[ -d "$SHARED_CONTEXT_DIR" ]]; then
  CLAUDE_EXTRA_ARGS+=(--add-dir "$SHARED_CONTEXT_DIR")
  echo "共有知識リポジトリを参照可能にします: $SHARED_CONTEXT_DIR"
else
  echo "共有知識リポジトリ（$SHARED_CONTEXT_DIR）が見つからないため、参照なしで起動します。"
fi

# 出力言語（#1395）。実装セッションと同じ文面・同じ扱い（scripts/lib/agent-language.sh）。
append_language_system_prompt

# 権限モード（#1205）。既定は `auto`。実装セッション（run-issue-session.sh）と同じ理由・同じ
# 環境変数で切り替える。レビュー・統合エージェントも`gh pr view`・`gh pr merge`等のBashコマンドを
# 多用するため、`acceptEdits`のままでは都度停止する。
PERMISSION_MODE="${ISSUE_DECK_CLAUDE_PERMISSION_MODE:-auto}"

claude_export_max_retries

echo "Claude Codeセッションを権限モード $PERMISSION_MODE で起動します（このターミナルで実行）..."
# set -u 下で空配列の展開がエラーにならないよう ${arr[@]+...} で囲む
exec claude --permission-mode "$PERMISSION_MODE" ${CLAUDE_EXTRA_ARGS[@]+"${CLAUDE_EXTRA_ARGS[@]}"} "$PROMPT_CONTENT"
