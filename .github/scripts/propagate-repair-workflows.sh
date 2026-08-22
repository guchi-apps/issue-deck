#!/usr/bin/env bash
# 1リポジトリぶんの「不足しているcallerを追加するPR」を作る（#1948・#1475）。
#
# propagate-repair-workflows.yml から1リポジトリずつ呼ばれる。配るのは
# claude-conflict-resolve.yml / claude-ci-fix.yml / claude-pr-repair.yml の自動修復3種と、
# develop向けPRの自動マージ可否を判定する claude-review-develop.yml、
# 本番デプロイの一時的な失敗を1回だけ再実行する deploy-retry.yml（#2134）で、
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

# **`gh api`は失敗時もエラーJSONを標準出力へ出す。** `2>/dev/null`だけでは変数へJSONが入り、
# 「取得できた」と誤って扱う。終了コードを見て、失敗なら何も返さない。
api() {
  local out
  out="$(gh api "$@" 2>/dev/null)" || return 1
  printf '%s' "$out"
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

# 本番デプロイのワークフロー名。`deploy-retry.yml`の`workflow_run`の購読先に使う（#2134）。
# CIと同じく**ワークフローの名前**で購読するため、実物から取る。CRLFのリポジトリがあるので
# ここでも `tr -d '\r'` を通す。
DEPLOY_WORKFLOW=""
if [ -f .github/workflows/deploy.yml ]; then
  DEPLOY_WORKFLOW="$(tr -d '\r' < .github/workflows/deploy.yml | grep -m1 -E '^name:' | sed -E 's/^name:[[:space:]]*//; s/^["'"'"']//; s/["'"'"']$//')"
fi
case "$DEPLOY_WORKFLOW" in
  *'"'*) fail "デプロイワークフロー名に\"が含まれています: $DEPLOY_WORKFLOW" ;;
esac

# Signalyの通知に出すアプリ名。リポジトリ名をそのまま使う（deploy.ymlのNOTIFY_APPと揃う）
APP_NAME="${REPO#*/}"

CREATED=""
for FILE in $WORKFLOWS; do
  case "$FILE" in
    claude-ci-fix.yml | claude-conflict-resolve.yml | claude-pr-repair.yml | claude-review-develop.yml) ;;
    deploy-retry.yml)
      # **購読先の名前が取れないなら配らない。** 既定値で埋めると、名前の違うリポジトリで
      # 「置いてあるのに一度も発火しない」ワークフローが残り、そのことに誰も気づけない。
      if [ -z "$DEPLOY_WORKFLOW" ]; then
        echo "  deploy.yml のワークフロー名を取得できません。スキップします"
        continue
      fi
      ;;
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
    | sed -e "s|__TAG__|$TAG|g" -e "s|__CI_WORKFLOW__|$CI_WORKFLOW|g" \
          -e "s|__DEPLOY_WORKFLOW__|$DEPLOY_WORKFLOW|g" -e "s|__APP_NAME__|$APP_NAME|g" > "$TARGET" \
    || fail "$FILE の生成に失敗しました"

  CREATED="$CREATED $FILE"
done

CREATED="${CREATED# }"

if [ -z "$(git status --porcelain)" ]; then
  echo "  追加するワークフローがありません。スキップします"
  exit 0
fi

# ---------------------------------------------------------------------------
# claude-review-develop.yml を配るときは、配布先の**前提が揃っているかを確かめる**（#1475）。
#
# **`develop`のブランチ保護（必須ステータスチェック）が無いと自動マージは成立しない。**
# 保護が無いPRは判定の時点で「既にマージ可能」なので`gh pr merge --auto`が断られ、
# auto-merge-fallbackが毎回`00.check-user`を付けるだけで終わる（実測で未配布12リポジトリ
# すべてに保護が無かった）。同じ保護は`release-develop-to-main.yml`のバンプPRの`--auto`にも効く。
#
# **ここでは設定を変えない。** `WORKFLOW_PAT`は Contents / Issues / Pull requests / Actions /
# Workflows / Metadata だけで、**Administration を持たない**（docs/organization-migration.md）。
# `PATCH /repos/{repo}`（allow_auto_merge）もブランチ保護APIも Administration: write が要る。
# 実際、`propagate-workflow-tag.sh`は配布のたびに`allow_auto_merge=true`を`|| true`付きで
# 試しているが、タグ配布PRが何度もマージされたリポジトリを含む12件中8件が今も`false`のまま
# だった——**失敗が握り潰されて一度も表に出ていなかった。** 同じ形を増やさず、
# 揃っていなければ警告し、PR本文へ残す。設定はユーザーが`scripts/setup-develop-auto-merge.sh`
# で一度だけ行う。
#
# 保護の有無は`branches/develop`の`protected`で見る。`branches/develop/protection`は
# 必須チェック名まで返す代わりに Administration が要り、このトークンでは読めない。
# ---------------------------------------------------------------------------
PREREQ_NOTE=""
PREREQ_MISSING=false

add_note() {
  PREREQ_NOTE="${PREREQ_NOTE}${PREREQ_NOTE:+$'\n'}- $1"
}

check_auto_merge_prerequisites() {
  local allow protected

  allow="$(api "repos/$REPO" --jq '.allow_auto_merge')"
  if [ "$allow" = "true" ]; then
    add_note '`Allow auto-merge`: 有効'
  else
    PREREQ_MISSING=true
    echo "  ::warning::$REPO: Allow auto-merge が無効です。このままでは自動マージは効きません"
    add_note '`Allow auto-merge`: **無効**。有効にするまで自動マージは効かない'
  fi

  protected="$(api "repos/$REPO/branches/develop" --jq '.protected')"
  if [ "$protected" = "true" ]; then
    add_note '`develop`のブランチ保護: あり'
  else
    PREREQ_MISSING=true
    echo "  ::warning::$REPO: develop にブランチ保護がありません。このままでは自動マージは効きません"
    add_note '`develop`のブランチ保護: **なし**。必須ステータスチェックが無いPRは`gh pr merge --auto`が「既にマージ可能」として断られ、毎回`00.check-user`が付くだけになる'
  fi

  if [ "$PREREQ_MISSING" = "true" ]; then
    add_note "**このPRをマージする前に、$SOURCE_REPO の\`scripts/setup-develop-auto-merge.sh\`で前提を揃えること**（org ownerの権限が要るため、ワークフローからは実行できない）"
  fi
}

case " $CREATED " in
  *" claude-review-develop.yml "*) check_auto_merge_prerequisites ;;
esac

[ -n "$PREREQ_NOTE" ] || PREREQ_NOTE="- （このPRに関係するリポジトリ設定はありません）"

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

PR_BODY="$(printf '## 実装内容\n\nこのリポジトリに置かれていなかったワークフロー（caller）を追加した。\n\n追加: %s\n参照タグ: `%s`（`claude-issue-dispatch.yml` と同じ）\nCIワークフロー名: `%s`（`workflow_run` の購読先）\n\n`with:` の `runtime-setup`・`package-manager`・`node-version` は `claude-issue-dispatch.yml`\nから写している（自動修復の3種のみ。`claude-review-develop.yml` はこれらの入力を宣言して\nいないため写していない）。**`verify-commands`・`build-env` は入っていない**（リポジトリごとに\n違うため）。検証を強くしたい場合は、%s 本体の同名ファイルを参考に後から足す。\n\n### 自動マージの前提（`claude-review-develop.yml`を含む場合）\n\n%s\n\n## 確認方法\n\n- このPRのCIが成功すること\n- マージ後、Actionsの一覧に追加したワークフローが出ること\n- issue-deckの画面で、詰まっているPRの「CI失敗を自動修正」「コンフリクトを自動解消」が\n  エラーにならずに起動すること（`workflow_dispatch` の受け口はデフォルトブランチの定義から\n  解決されるため、**マージするまでは起動できない**）\n- `claude-review-develop.yml` を含む場合: マージ後の次のdevelop向けPRで `Claude Code Review`\n  が走り、低リスクPRなら `00.check-user` が付かずに自動マージされること\n\n## 注意点\n\n- **`workflow_run` はワークフローの名前で購読する。** このリポジトリのCIの名前が `%s` から\n  変わったら、このファイルも直す（黙って発火しなくなる）。`deploy-retry.yml` を含む場合は\n  本番デプロイの名前（`%s`）も同じ扱い\n- **`deploy-retry.yml` が再実行するのは `build`・`deploy` ジョブの失敗だけ。** このリポジトリの\n  `deploy.yml` のジョブ名が違う場合は、`with:` に `retryable-jobs` を足して合わせる\n  （合っていないジョブだけが失敗したときは、安全側に倒れて再実行しない）\n- **`claude-review-develop.yml` の自動マージには `develop` のブランチ保護が要る。** 保護が\n  無いと `gh pr merge --auto` が「既にマージ可能」として断られ、毎回 `00.check-user` が付く\n  だけで終わる（上の「自動マージの前提」を参照）\n- **自動マージしない。** 新しいワークフローの追加はGitHub Actionsの変更にあたるため、\n  内容を確認して手でマージする\n\n---\n\n%s の画面から一括作成されたPRです（対応Issueは作成していない）。\n' "$CREATED" "$TAG" "$CI_WORKFLOW" "$SOURCE_REPO" "$PREREQ_NOTE" "$CI_WORKFLOW" "$DEPLOY_WORKFLOW" "$SOURCE_REPO")"

PR_URL="$(gh pr create --repo "$REPO" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "不足しているワークフローを追加する" \
  --body "$PR_BODY" 2>/dev/null)" \
  || fail "PRの作成に失敗しました"

echo "  作成しました: $PR_URL"
