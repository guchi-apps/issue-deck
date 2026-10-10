#!/usr/bin/env bash
# 1リポジトリぶんの「バックアップCI（CircleCI）導入・更新PR」を作る（#4308）。
#
# propagate-backup-ci.yml から1リポジトリずつ呼ばれる。配るのは次の3つ。
#   - .circleci/config.yml              … 配布元（issue-deck）の実物。写しの雛形は持たない
#   - scripts/ci/run-required-checks.mjs … 同上。サーバー側のダイジェスト計算と同一でなければならない
#   - ci/required-checks.json           … **対象の .github/workflows/ci.yml から生成する**。
#                                          グループ名＝ci.ymlのジョブ名（共通チェックの照合規則。
#                                          src/lib/backup-ci/gate.ts の evaluateActionsRun）
#
# **IssueDeck固有の検査・固定のリポジトリ名は配らない**（定義は対象ごとに生成する）。
# **既存ファイルを黙って上書きしない。** 自分たちの配布物と判別できないものは触らず、PR本文に理由を書く。
# 置き換える場合も、差分は PR の diff で確認できる。自動マージはしない（Actions/CI設定の変更のため）。
# **重複PRを作らない。** ブランチ名は固定で、openなPRが既にあればブランチを更新するだけ。
#
# 1リポジトリの失敗で全体を止めない前提で書かれている。失敗時は非0で返す。
set -uo pipefail

REPO="$1"        # owner/repo
SOURCE_REPO="$2" # 配布元（guchi-apps/issue-deck）
SOURCE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BRANCH="backup-ci-rollout"

fail() {
  echo "  $1" >&2
  exit 1
}

DEFAULT_BRANCH="$(gh api "repos/$REPO" --jq .default_branch 2>/dev/null)" || fail "リポジトリ情報を取得できません"
# バックアップCIはdevelop向けPRが対象。developを持つリポジトリはdevelopへ、無ければ既定ブランチへ
if gh api "repos/$REPO/branches/develop" >/dev/null 2>&1; then BASE="develop"; else BASE="$DEFAULT_BRANCH"; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --depth 1 --branch "$BASE" "https://x-access-token:${GH_TOKEN}@github.com/$REPO.git" "$WORK/repo" || fail "cloneに失敗しました"
cd "$WORK/repo" || fail "作業ディレクトリへ移動できません"

[ -f pnpm-lock.yaml ] || fail "pnpm-lock.yaml がありません（配布するconfigはNode.js/pnpmを前提にしています）。対象外です"
[ -f .github/workflows/ci.yml ] || fail ".github/workflows/ci.yml がありません（共通チェックの照合先がありません）"

NOTES="$WORK/notes.md"
: > "$NOTES"
ACTIONS=""

# ── 検査定義をci.ymlから生成する ───────────────────────────────────────────────
python3 - "$WORK/definition.json" "$WORK/definition-notes.md" <<'PY' || fail "ci.ymlから検査定義を生成できませんでした（ジョブに写せる検査が無い、または読み取りに失敗）"
import json, re, sys, yaml

out, notes_path = sys.argv[1], sys.argv[2]
wf = yaml.safe_load(open(".github/workflows/ci.yml"))
on = wf.get(True, wf.get("on", {}))
if "pull_request" not in (on if isinstance(on, (dict, list)) else [on]):
    raise SystemExit("ci.yml が pull_request で起動しません")

NOTIFY = re.compile(r"(^|[-_])(notify|notice|notification)([-_]|$)", re.I)
UNSUPPORTED_JOB = re.compile(r"(^|[-_])(ios|macos|testflight|xcode|android|e2e)([-_]|$)", re.I)
IGNORED_USES = ("actions/checkout", "actions/setup-node", "pnpm/action-setup", "actions/cache", "actions/upload-artifact")
INSTALL = re.compile(r"^\s*(pnpm|npm|yarn)\s+(install|i|ci)\b|^\s*corepack\s+enable")

node = "22"
groups, notes, excluded = {}, [], []
for job_id, job in (wf.get("jobs") or {}).items():
    name = str(job.get("name") or job_id)
    runs_on = str(job.get("runs-on", ""))
    if NOTIFY.search(job_id) or NOTIFY.search(name):
        continue  # 通知だけのジョブは定義に入れない
    if re.match(r"(macos|windows)", runs_on, re.I) or UNSUPPORTED_JOB.search(job_id) or "${{" in name:
        notes.append(f"- `{name}`: Linuxで代替できない／名前が動的なため定義に入れていません（既存経路の必須判定を残してください）")
        excluded.append(name)
        continue
    if "matrix" in (job.get("strategy") or {}):
        notes.append(f"- `{name}`: matrixのため定義に入れていません")
        excluded.append(name)
        continue
    checks, reason = [], None
    for i, step in enumerate(job.get("steps") or []):
        uses = step.get("uses")
        if uses:
            if uses.startswith(IGNORED_USES):
                nv = (step.get("with") or {}).get("node-version")
                if nv and "${{" not in str(nv):
                    node = str(nv).split(".")[0]
                continue
            reason = f"`{uses}` は写せません"
            break
        run = step.get("run")
        if not run or INSTALL.search(run):
            continue
        env = {**(job.get("env") or {}), **(step.get("env") or {})}
        text = json.dumps([run, env])
        if "secrets." in text or "${{" in text:
            reason = f"ステップ「{step.get('name', run.splitlines()[0])}」がsecretsや式に依存しています"
            break
        sid = re.sub(r"[^a-z0-9]+", "-", str(step.get("name", f"step-{i}")).lower()).strip("-") or f"step-{i}"
        check = {"id": sid, "name": str(step.get("name", sid)), "run": run.strip()}
        if env:
            check["env"] = {k: str(v) for k, v in env.items()}
        checks.append(check)
    if reason or not checks:
        notes.append(f"- `{name}`: {reason or '写せる検査がありません'}。定義に入れていません（既存経路の必須判定を残してください）")
        excluded.append(name)
        continue
    groups[name] = {"needsDependencies": True, "checks": checks}

if not groups:
    raise SystemExit("定義に入れられるジョブがありません")
definition = {
    "$comment": "バックアップCIの必須検査の定義（#4308。ci.ymlのジョブから生成）。グループ名はci.ymlのジョブ名と一致させること（共通チェックの照合規則）。検査を足すときはここへ足し、ワークフロー側と食い違わせない。",
    "schemaVersion": 1,
    "runtime": {"node": node, "packageManager": "pnpm"},
    # 意図して定義に入れなかったジョブ。issue-deckの対応検査は、ここにあるジョブを「欠落」とは見ない
    # （バックアップCIでは検査されない。既存経路の必須判定を残すこと）
    "excludedJobs": excluded,
    "groups": groups,
}
open(out, "w").write(json.dumps(definition, ensure_ascii=False, indent=2) + "\n")
open(notes_path, "w").write("\n".join(notes) + ("\n" if notes else ""))
PY

place() { # <配布元の実物> <配布先パス> <自分たちの配布物と判別する語>
  local src="$1" dst="$2" marker="$3"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && ! grep -q "$marker" "$dst"; then
    printf -- '- `%s`: 既存のファイルが配布物と判別できないため**上書きしていません**。内容を確認し、必要なら手で統合してください\n' "$dst" >> "$NOTES"
    return
  fi
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then return; fi
  [ -f "$dst" ] && ACTIONS="$ACTIONS\n- 更新: \`$dst\`" || ACTIONS="$ACTIONS\n- 追加: \`$dst\`"
  cat "$src" > "$dst"
  chmod --reference="$src" "$dst" 2>/dev/null || true
}

place "$SOURCE_DIR/.circleci/config.yml" .circleci/config.yml "backup_ci"
place "$SOURCE_DIR/scripts/ci/run-required-checks.mjs" scripts/ci/run-required-checks.mjs "run-required-checks"
place "$WORK/definition.json" ci/required-checks.json '"schemaVersion"'
cat "$WORK/definition-notes.md" >> "$NOTES"

if [ -z "$(git status --porcelain)" ]; then
  echo "  更新するファイルがありません。スキップします"
  exit 0
fi

git checkout --quiet -b "$BRANCH" || fail "ブランチを作成できません"
git add -A
git commit --quiet -m "$(printf 'バックアップCI（CircleCI）を導入・更新する\n\nGitHub Actions障害時にdevelop向けPRの検証を続けるための設定。配布元: %s（#4308）\n' "$SOURCE_REPO")" || fail "コミットに失敗しました"

if ! git push --quiet -u origin "$BRANCH"; then
  git fetch --quiet --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" || fail "pushに失敗しました（残っているブランチも取得できません）"
  REMOTE_SHA="$(git rev-parse "refs/remotes/origin/$BRANCH")" || fail "pushに失敗しました"
  git push --quiet --force-with-lease="$BRANCH:$REMOTE_SHA" -u origin "$BRANCH" || fail "pushに失敗しました"
fi

# openなPRが既にあれば、ブランチを更新しただけで終える（重複PRを作らない）
EXISTING="$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json url --jq '.[0].url // empty' 2>/dev/null)"
if [ -n "$EXISTING" ]; then
  echo "  既存のPRを更新しました: $EXISTING"
  exit 0
fi

NOTE_TEXT="$(cat "$NOTES")"
[ -n "$NOTE_TEXT" ] || NOTE_TEXT="なし"
PR_BODY="$(printf '## 実装内容\n\nGitHub Actions障害時に、CircleCIでdevelop向けPRの必須検査を実行できるようにする設定を配布する（%s の画面から作成。起点: %s#4308）。\n%b\n\n## 要確認（上書きしなかったもの・定義に入れなかったジョブ）\n\n%s\n\n## 注意点\n\n- **このPRをマージしただけでは使えません。** CircleCIでこのリポジトリのプロジェクトを作り（GitHub App連携・トリガーは作らない）、issue-deckの画面でスラッグと定義IDを保存し、試験PRで実起動を確認してください\n- `ci/required-checks.json` のグループ名は ci.yml のジョブ名です。**ジョブ名を変えたら定義も変える**（ずれると共通チェックが成立しません）\n- 通常のpush/PRではCircleCIは動きません。必須チェックの移行は issue-deck の画面に出る手順で段階的に行ってください\n- **自動マージしません。** CI設定の変更のため、内容を確認して手でマージしてください\n' \
  "$SOURCE_REPO" "$SOURCE_REPO" "$ACTIONS" "$NOTE_TEXT")"

PR_URL="$(gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "バックアップCI（CircleCI）を導入・更新する" --body "$PR_BODY" 2>/dev/null)" || fail "PRの作成に失敗しました"
echo "  作成しました: $PR_URL"
