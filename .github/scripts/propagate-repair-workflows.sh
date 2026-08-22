#!/usr/bin/env bash
# 1リポジトリぶんの「不足しているcallerを追加するPR」を作る（#1948・#1475）。
#
# propagate-repair-workflows.yml から1リポジトリずつ呼ばれる。配るのは
# claude-conflict-resolve.yml / claude-ci-fix.yml / claude-pr-repair.yml の自動修復3種と、
# develop向けPRの自動マージ可否を判定する claude-review-develop.yml で、
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
TEMPLATE_DIR="$(cd "$(dirname "$0")/../templates/callers" && pwd)"

# `with:` に写す入力。**写す先の再利用ワークフローが宣言している名前だけ**にする。
# 宣言されていない入力を渡すとワークフローの読み込み自体が失敗する。写すのは
# `__WITH_INPUTS__`を持つ雛形（自動修復3種）だけで、claude-review-develop.yml は
# これらの入力を宣言していないため写さない。
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

# CIのワークフローファイル。名前とジョブ名の両方をここから取る。
# **CRLFのリポジトリがある**（asset-manager）。`tr -d '\r'`で落とさないと、名前の末尾に
# CRが残ったまま雛形へ差し込まれ、購読先・必須チェック名として一致しなくなる。
CI_FILE=""
for CANDIDATE in .github/workflows/ci.yml .github/workflows/test.yml; do
  [ -f "$CANDIDATE" ] && { CI_FILE="$CANDIDATE"; break; }
done

# CIワークフローの名前。workflow_run は**ワークフローの名前**で購読するため、実物から取る
# （`CI`固定にすると、名前が違うリポジトリでは黙って発火しないまま残る）。
CI_WORKFLOW=""
if [ -n "$CI_FILE" ]; then
  CI_WORKFLOW="$(tr -d '\r' < "$CI_FILE" | grep -m1 -E '^name:' | sed -E 's/^name:[[:space:]]*//; s/^["'"'"']//; s/["'"'"']$//')"
fi
# 見つからない場合も配る（自動検知は効かないが、issue-deckの画面のボタンからは起動できる）
[ -n "$CI_WORKFLOW" ] || CI_WORKFLOW="CI"
case "$CI_WORKFLOW" in
  *'"'*) fail "CIワークフロー名に\"が含まれています: $CI_WORKFLOW" ;;
esac

# 参照元から写す with: の行（インデントごとそのまま使う）
WITH_INPUTS="$WORK/with-inputs.txt"
grep -E "^      ($COPIED_INPUTS):" "$DISPATCH_CALLER" > "$WITH_INPUTS"

CREATED=""
for FILE in $WORKFLOWS; do
  case "$FILE" in
    claude-ci-fix.yml | claude-conflict-resolve.yml | claude-pr-repair.yml | claude-review-develop.yml) ;;
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

  # 写す値が要る雛形のときだけ、参照元から取れているかを確かめる。
  # claude-review-develop.yml は写さないため、取れていなくても配れる。
  if grep -q '__WITH_INPUTS__' "$TEMPLATE_DIR/$FILE" && [ ! -s "$WITH_INPUTS" ]; then
    fail "$DISPATCH_CALLER から写せる with: の値がありません"
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

# ---------------------------------------------------------------------------
# claude-review-develop.yml を配るときは、配布先のリポジトリ設定も揃える（#1475）。
#
# **`develop`のブランチ保護（必須ステータスチェック）が無いと自動マージは成立しない。**
# 保護が無いPRは判定の時点で「既にマージ可能」なので`gh pr merge --auto`が断られ、
# auto-merge-fallbackが毎回`00.check-user`を付けるだけで終わる。callerだけ置いても
# 効かないため、ここで前提を作る（実測で未配布12リポジトリすべてに保護が無かった）。
# 同じ保護は`release-develop-to-main.yml`のバンプPRの`--auto`にも効く。
# ---------------------------------------------------------------------------
PREREQ_NOTE=""

add_note() {
  PREREQ_NOTE="${PREREQ_NOTE}${PREREQ_NOTE:+$'\n'}- $1"
}

setup_auto_merge_prerequisites() {
  if gh api -X PATCH "repos/$REPO" -F allow_auto_merge=true >/dev/null 2>&1; then
    echo "  Allow auto-merge を有効化しました"
  else
    echo "  ::warning::Allow auto-merge を有効化できませんでした"
    add_note '`Allow auto-merge`を有効化できなかった。リポジトリ設定から手で有効にする（無いと自動マージは効かない）'
  fi

  local existing contexts sha
  existing="$(gh api "repos/$REPO/branches/develop/protection" \
    --jq '[.required_status_checks.contexts[]?] | join(", ")' 2>/dev/null)"
  if [ -n "$existing" ]; then
    echo "  develop には既に必須ステータスチェックがあります: $existing"
    add_note "\`develop\`の必須ステータスチェックは既にあるため触っていない（\`$existing\`）"
    return 0
  fi

  # **必須チェック名をワークフローのジョブ名から推測しない。** 実在しない名前を必須に
  # すると永久に埋まらずマージ不能になる（docs/organization-migration-checklist.md）。
  # CIのジョブ名のうち、**直近のdevelop向けPRで実際にcheck runとして走ったものだけ**を採る。
  contexts=""
  if [ -n "$CI_FILE" ]; then
    sha="$(gh api "repos/$REPO/pulls?base=develop&state=closed&per_page=20" \
      --jq 'map(select(.merged_at != null)) | .[0].head.sha // empty' 2>/dev/null)"
    if [ -n "$sha" ]; then
      # `notify`は失敗時にだけ走るリポジトリがあるため必須にしない
      tr -d '\r' < "$CI_FILE" \
        | awk '/^jobs:/ { injobs = 1; next } injobs && /^  [A-Za-z0-9_-]+:/ { sub(/:.*$/, ""); gsub(/ /, ""); print }' \
        | grep -vx notify | sort -u > "$WORK/ci-jobs.txt"
      # 既定のper_pageは30。develop向けPRには他ワークフローのcheck runも並ぶため
      # （実測でも1コミットに24件）、取りこぼすとCIのジョブ名が見つからず保護を作れない
      gh api "repos/$REPO/commits/$sha/check-runs?per_page=100" --jq '.check_runs[].name' 2>/dev/null \
        | sort -u > "$WORK/check-runs.txt"
      contexts="$(comm -12 "$WORK/ci-jobs.txt" "$WORK/check-runs.txt" | tr '\n' ' ')"
      contexts="${contexts%% }"
    fi
  fi

  if [ -z "${contexts// /}" ]; then
    echo "  ::warning::developの必須ステータスチェックに使える名前を確認できませんでした。保護は作りません"
    add_note '`develop`のブランチ保護を作れなかった（CIのジョブ名を直近のPRのcheck runで確認できなかった）。**保護が無いあいだ自動マージは効かない**'
    return 0
  fi

  if jq -n --arg names "$contexts" '{
        required_status_checks: { strict: false, contexts: ($names | split(" ") | map(select(. != ""))) },
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false
      }' | gh api -X PUT "repos/$REPO/branches/develop/protection" --input - >/dev/null 2>&1; then
    echo "  developのブランチ保護を作成しました（必須チェック: $contexts）"
    add_note "\`develop\`のブランチ保護を作成した（必須ステータスチェック: \`$contexts\`）"
  else
    echo "  ::warning::developのブランチ保護を作成できませんでした"
    add_note '`develop`のブランチ保護を作成できなかった。**保護が無いあいだ自動マージは効かない**'
  fi
}

case " $CREATED " in
  *" claude-review-develop.yml "*) setup_auto_merge_prerequisites ;;
esac

[ -n "$PREREQ_NOTE" ] || PREREQ_NOTE="- （リポジトリ設定の変更なし）"

# ブランチ名は固定。`issue-*`ではないため、配布先の issue-labels.yml（push on issue-*）は動かない
BRANCH="repair-workflows"

git checkout --quiet -b "$BRANCH" || fail "ブランチを作成できません"
git add -A

COMMIT_MESSAGE="$(printf '不足しているワークフローを追加する\n\n自動修復（claude-ci-fix・claude-conflict-resolve・claude-pr-repair）はissue-deckの画面から\nworkflow_dispatchで起動するため、callerが無いリポジトリでは押しても起動しない。\nclaude-review-develop はdevelop向けPRの自動マージ可否を判定する唯一の経路で、\n無いリポジトリでは低リスクPRも含めて全て手動マージになる。\n参照タグとwith:の値は claude-issue-dispatch.yml から写している。\n\n追加: %s\n' "$CREATED")"
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

PR_BODY="$(printf '## 実装内容\n\nこのリポジトリに置かれていなかったワークフロー（caller）を追加した。\n\n追加: %s\n参照タグ: `%s`（`claude-issue-dispatch.yml` と同じ）\nCIワークフロー名: `%s`（`workflow_run` の購読先）\n\n`with:` の `runtime-setup`・`package-manager`・`node-version` は `claude-issue-dispatch.yml`\nから写している（自動修復の3種のみ。`claude-review-develop.yml` はこれらの入力を宣言して\nいないため写していない）。**`verify-commands`・`build-env` は入っていない**（リポジトリごとに\n違うため）。検証を強くしたい場合は、%s 本体の同名ファイルを参考に後から足す。\n\n### リポジトリ設定\n\n%s\n\n## 確認方法\n\n- このPRのCIが成功すること\n- マージ後、Actionsの一覧に追加したワークフローが出ること\n- issue-deckの画面で、詰まっているPRの「CI失敗を自動修正」「コンフリクトを自動解消」が\n  エラーにならずに起動すること（`workflow_dispatch` の受け口はデフォルトブランチの定義から\n  解決されるため、**マージするまでは起動できない**）\n- `claude-review-develop.yml` を含む場合: マージ後の次のdevelop向けPRで `Claude Code Review`\n  が走り、低リスクPRなら `00.check-user` が付かずに自動マージされること\n\n## 注意点\n\n- **`workflow_run` はワークフローの名前で購読する。** このリポジトリのCIの名前が `%s` から\n  変わったら、このファイルも直す（黙って発火しなくなる）\n- **`claude-review-develop.yml` の自動マージには `develop` のブランチ保護が要る。** 保護が\n  無いと `gh pr merge --auto` が「既にマージ可能」として断られ、毎回 `00.check-user` が付く\n  だけで終わる（上の「リポジトリ設定」を参照）\n- **自動マージしない。** 新しいワークフローの追加はGitHub Actionsの変更にあたるため、\n  内容を確認して手でマージする\n\n---\n\n%s の画面から一括作成されたPRです（対応Issueは作成していない）。\n' "$CREATED" "$TAG" "$CI_WORKFLOW" "$SOURCE_REPO" "$PREREQ_NOTE" "$CI_WORKFLOW" "$SOURCE_REPO")"

PR_URL="$(gh pr create --repo "$REPO" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "不足しているワークフローを追加する" \
  --body "$PR_BODY" 2>/dev/null)" \
  || fail "PRの作成に失敗しました"

echo "  作成しました: $PR_URL"
