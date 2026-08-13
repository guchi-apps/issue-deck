#!/usr/bin/env bash
# 1リポジトリぶんの「参照タグを上げるPR」を作る（#1173）。
#
# propagate-workflow-tag.yml から1リポジトリずつ呼ばれる。手作業でv11・v12を配ったときの
# 手順（clone → ブランチ作成 → sed → commit → push → PR作成）をそのまま移したもの。
#
# **このスクリプトは1リポジトリの失敗で全体を止めない前提で書かれている。** 呼び出し元が
# 戻り値を見て件数を数えるため、失敗時は非0で返すこと。
set -uo pipefail

REPO="$1"          # owner/repo
TAG="$2"           # workflows/vN
SOURCE_REPO="$3"   # 共有ワークフローの提供元（guchi-apps/issue-deck）

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

# 既にすべて目的のタグを指しているなら何もしない。空のPRを作らないため
if ! grep -rlE '@workflows/v[0-9]+' .github/workflows/ >/dev/null 2>&1; then
  echo "  共有ワークフローを参照していません。スキップします"
  exit 0
fi
if ! grep -rhoE "@workflows/v[0-9]+|prompts-ref: workflows/v[0-9]+" .github/workflows/ \
  | grep -qv "${TAG#workflows/}\$"; then
  echo "  既に $TAG です。スキップします"
  exit 0
fi

BEFORE="$(grep -rhoE '@workflows/v[0-9]+' .github/workflows/ | sort -u | tr '\n' ' ')"

# **uses: と prompts-ref を必ず同時に書き換える。** 片方だけ上げると、新しいワークフローで
# 古いプロンプトが使われる（#1158 で ${PACKAGE_MANAGER} を足した際に実際に問題になる形）。
for FILE in .github/workflows/*.yml; do
  grep -q '@workflows/v' "$FILE" || continue
  sed -i \
    -e "s|@workflows/v[0-9]\+|@$TAG|g" \
    -e "s|prompts-ref: workflows/v[0-9]\+|prompts-ref: $TAG|g" \
    "$FILE"
done

if [ -z "$(git status --porcelain)" ]; then
  echo "  変更がありません。スキップします"
  exit 0
fi

CHANGED="$(git diff --name-only | sed 's|.github/workflows/||' | tr '\n' ' ')"

ISSUE_BODY="$(cat <<EOF
共有ワークフローの参照タグを **\`$TAG\`** へ上げる。

issue-deck 側の改善は、**各リポジトリの参照タグを上げるまで反映されない。** 上げ忘れても
何も起きないため気づけない（実際 \`workflows/v10\` は1リポジトリにしか配られていなかった）。

## 変更対象

$CHANGED

現在の参照: $BEFORE

## 注意点

\`uses:\` と \`prompts-ref\` は必ず同じ値にする。片方だけ上げると、新しいワークフローで
古いプロンプトが使われる。

**GitHub Actions の変更のため、自動マージ不可カテゴリに該当する。**

---

$SOURCE_REPO の画面から一括作成されたIssueです。
EOF
)"

ISSUE_URL="$(gh issue create --repo "$REPO" \
  --title "共有ワークフローの参照を$TAGへ上げる" \
  --body "$ISSUE_BODY" 2>/dev/null)" || fail "Issueの作成に失敗しました"

ISSUE_NUMBER="${ISSUE_URL##*/}"
BRANCH="issue-$ISSUE_NUMBER"

git checkout --quiet -b "$BRANCH" || fail "ブランチを作成できません"
git add -A

COMMIT_MESSAGE="$(printf '共有ワークフローの参照を%sへ上げる\n\nissue-deck側の改善は、各リポジトリの参照タグを上げるまで反映されない。\nuses: と prompts-ref は必ず同じ値にする（片方だけ上げると新しいワークフローで\n古いプロンプトが使われる）。\n\n#%s\n' "$TAG" "$ISSUE_NUMBER")"
git commit --quiet -m "$COMMIT_MESSAGE" || fail "コミットに失敗しました"

git push --quiet -u origin "$BRANCH" || fail "pushに失敗しました"

PR_URL="$(gh pr create --repo "$REPO" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "共有ワークフローの参照を$TAGへ上げる" \
  --body "$(printf '## 対応Issue\n\n#%s\n\n## 実装内容\n\n参照タグを **`%s`** へ上げた。**`uses:` と `prompts-ref` を同じ値にしてある。**\n\n変更対象: %s\n変更前の参照: %s\n\n## 確認方法\n\nこのPRの Actions で `labels / wip-on-push` が成功すること。\n\n## 注意点\n\n**GitHub Actions の変更のため、自動マージ不可カテゴリに該当する。**\n\n---\n\n%s の画面から一括作成されたPRです。\n' "$ISSUE_NUMBER" "$TAG" "$CHANGED" "$BEFORE" "$SOURCE_REPO")" 2>/dev/null)" \
  || fail "PRの作成に失敗しました"

echo "  作成しました: $PR_URL"
