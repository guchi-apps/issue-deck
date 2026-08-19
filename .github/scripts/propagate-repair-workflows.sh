#!/usr/bin/env bash
# 1リポジトリぶんの「不足している自動修復callerを追加するPR」を作る（#1948）。
#
# propagate-repair-workflows.yml から1リポジトリずつ呼ばれる。配るのは
# claude-conflict-resolve.yml / claude-ci-fix.yml / claude-pr-repair.yml の3種で、
# **どれを配るかは呼び出し元（issue-deckの画面）が決めて渡す**（ここで再検知すると画面の
# 表示と実際の対象がずれる。propagate-workflow-tag.sh と同じ方針）。
#
# **タグ配布（propagate-workflow-tag.sh）と違い、自動マージはしない。** 配るのは新しい
# ワークフローファイルそのもので、`@workflows/vN`の機械的な置換とは別物のため、
# 各リポジトリでPRを確認してマージする。
#
# **このスクリプトは1リポジトリの失敗で全体を止めない前提で書かれている。** 呼び出し元が
# 戻り値を見て件数を数えるため、失敗時は非0で返すこと。
set -uo pipefail

REPO="$1"        # owner/repo
WORKFLOWS="$2"   # 配るファイル名（空白区切り。例: "claude-ci-fix.yml claude-pr-repair.yml"）
SOURCE_REPO="$3" # 共有ワークフローの提供元（guchi-apps/issue-deck）

# 雛形はこのリポジトリ（issue-deck）のチェックアウトから読む
TEMPLATE_DIR="$(cd "$(dirname "$0")/../templates/repair-callers" && pwd)"

# `with:` に写す入力。**3つの再利用ワークフローすべてが宣言している名前だけ**にする。
# 宣言されていない入力を渡すとワークフローの読み込み自体が失敗する。
COPIED_INPUTS="runtime-setup|package-manager|node-version"

# 参照元。ここから uses: のタグと with: の値を写す
DISPATCH_CALLER=".github/workflows/claude-issue-dispatch.yml"

fail() {
  echo "  $1" >&2
  exit 1
}

DEFAULT_BRANCH="$(gh api "repos/$REPO" --jq .default_branch 2>/dev/null)" \
  || fail "リポジトリ情報を取得できません"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --depth 1 --branch "$DEFAULT_BRANCH" "https://x-access-token:${GH_TOKEN}@github.com/$REPO.git" "$WORK/repo" \
  || fail "cloneに失敗しました"

cd "$WORK/repo" || fail "作業ディレクトリへ移動できません"

# **参照元が無ければ配らない。** タグも with: の値も写せず、既定値だけの caller を置くと
# ランタイムの用意が合わずに失敗する（例: pnpmのリポジトリへnpmの既定値を置く）。
[ -f "$DISPATCH_CALLER" ] || fail "$DISPATCH_CALLER がありません（先に無人実行のcallerを導入する）"

TAG="$(grep -oE '^\s*uses:.*@workflows/v[0-9]+' "$DISPATCH_CALLER" | grep -oE 'workflows/v[0-9]+' | head -1)"
[ -n "$TAG" ] || fail "$DISPATCH_CALLER が共有ワークフローのタグを参照していません"

# CIワークフローの名前。workflow_run は**ワークフローの名前**で購読するため、実物から取る
# （`CI`固定にすると、名前が違うリポジトリでは黙って発火しないまま残る）。
CI_WORKFLOW=""
for CANDIDATE in .github/workflows/ci.yml .github/workflows/test.yml; do
  [ -f "$CANDIDATE" ] || continue
  CI_WORKFLOW="$(grep -m1 -E '^name:' "$CANDIDATE" | sed -E 's/^name:[[:space:]]*//; s/^["'"'"']//; s/["'"'"']$//')"
  [ -n "$CI_WORKFLOW" ] && break
done
# 見つからない場合も配る（自動検知は効かないが、issue-deckの画面のボタンからは起動できる）
[ -n "$CI_WORKFLOW" ] || CI_WORKFLOW="CI"
case "$CI_WORKFLOW" in
  *'"'*) fail "CIワークフロー名に\"が含まれています: $CI_WORKFLOW" ;;
esac

# 参照元から写す with: の行（インデントごとそのまま使う）
WITH_INPUTS="$WORK/with-inputs.txt"
grep -E "^      ($COPIED_INPUTS):" "$DISPATCH_CALLER" > "$WITH_INPUTS"
[ -s "$WITH_INPUTS" ] || fail "$DISPATCH_CALLER から写せる with: の値がありません"

CREATED=""
for FILE in $WORKFLOWS; do
  case "$FILE" in
    claude-ci-fix.yml | claude-conflict-resolve.yml | claude-pr-repair.yml) ;;
    *)
      echo "  $FILE は配布対象外です。スキップします"
      continue
      ;;
  esac

  TARGET=".github/workflows/$FILE"
  if [ -f "$TARGET" ]; then
    echo "  $FILE は既にあります。スキップします"
    continue
  fi

  # 雛形の __WITH_INPUTS__ の行を、写した with: の行へ置き換える（他の行はそのまま）
  awk -v marker='__WITH_INPUTS__' '
    FNR == NR { block = block $0 "\n"; next }
    $0 ~ marker { printf "%s", block; next }
    { print }
  ' "$WITH_INPUTS" "$TEMPLATE_DIR/$FILE" \
    | sed -e "s|__TAG__|$TAG|g" -e "s|__CI_WORKFLOW__|$CI_WORKFLOW|g" > "$TARGET" \
    || fail "$FILE の生成に失敗しました"

  CREATED="$CREATED $FILE"
done

CREATED="${CREATED# }"

if [ -z "$(git status --porcelain)" ]; then
  echo "  追加するワークフローがありません。スキップします"
  exit 0
fi

# ブランチ名は固定。`issue-*`ではないため、配布先の issue-labels.yml（push on issue-*）は動かない
BRANCH="repair-workflows"

git checkout --quiet -b "$BRANCH" || fail "ブランチを作成できません"
git add -A

COMMIT_MESSAGE="$(printf '自動修復ワークフローを追加する\n\nissue-deckの画面の「CI失敗を自動修正」「コンフリクトを自動解消」は各リポジトリの\nワークフローをworkflow_dispatchで起動するため、callerが無いリポジトリでは押しても\n起動しない。参照タグとwith:の値は claude-issue-dispatch.yml から写している。\n\n追加: %s\n' "$CREATED")"
git commit --quiet -m "$COMMIT_MESSAGE" || fail "コミットに失敗しました"

# ブランチ名が固定のため、前回マージされずに閉じたPRの残骸が残っていることがある。
# **中身は毎回このスクリプトが作り直すもの**なので上書きしてよい（propagate-workflow-tag.sh と
# 同じ理由・同じ手順。単一ブランチcloneでは素の --force-with-lease が使えない）。
if ! git push --quiet -u origin "$BRANCH"; then
  git fetch --quiet --depth 1 origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
    || fail "pushに失敗しました（残っているブランチも取得できません）"

  REMOTE_SHA="$(git rev-parse "refs/remotes/origin/$BRANCH")" || fail "pushに失敗しました"
  git push --quiet --force-with-lease="$BRANCH:$REMOTE_SHA" -u origin "$BRANCH" \
    || fail "pushに失敗しました"
fi

PR_BODY="$(printf '## 実装内容\n\n自動修復のワークフロー（caller）を追加した。\n\n追加: %s\n参照タグ: `%s`（`claude-issue-dispatch.yml` と同じ）\nCIワークフロー名: `%s`（`workflow_run` の購読先）\n\n`with:` の `runtime-setup`・`package-manager`・`node-version` は `claude-issue-dispatch.yml`\nから写している。**`verify-commands`・`build-env` は入っていない**（リポジトリごとに違うため）。\n修正・解消後の検証を強くしたい場合は、%s 本体の同名ファイルを参考に後から足す。\n\n## 確認方法\n\n- このPRのCIが成功すること\n- マージ後、Actionsの一覧に追加したワークフローが出ること\n- issue-deckの画面で、詰まっているPRの「CI失敗を自動修正」「コンフリクトを自動解消」が\n  エラーにならずに起動すること（`workflow_dispatch` の受け口はデフォルトブランチの定義から\n  解決されるため、**マージするまでは起動できない**）\n\n## 注意点\n\n- **`workflow_run` はワークフローの名前で購読する。** このリポジトリのCIの名前が `%s` から\n  変わったら、このファイルも直す（黙って発火しなくなる）\n- **自動マージしない。** 新しいワークフローの追加はGitHub Actionsの変更にあたるため、\n  内容を確認して手でマージする\n\n---\n\n%s の画面から一括作成されたPRです（対応Issueは作成していない）。\n' "$CREATED" "$TAG" "$CI_WORKFLOW" "$SOURCE_REPO" "$CI_WORKFLOW" "$SOURCE_REPO")"

PR_URL="$(gh pr create --repo "$REPO" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "自動修復ワークフローを追加する" \
  --body "$PR_BODY" 2>/dev/null)" \
  || fail "PRの作成に失敗しました"

echo "  作成しました: $PR_URL"
