#!/usr/bin/env bash
# `develop`向けPRの自動マージが成立する状態を作る（#1475）。
#
# **`claude-review-develop.yml`を置いても、これが済んでいなければ自動マージは1本も
# 成立しない。** `auto-merge`ジョブの`gh pr merge --auto`は、PRが既にマージ可能だと
# 「既にマージ可能」として断られる。必須ステータスチェックが無いPRは判定の時点で常に
# その状態なので、ジョブは毎回失敗し`auto-merge-fallback`が`00.check-user`を付ける——
# 未配布のときと同じ「全て手動マージ」に、失敗したジョブのぶんノイズが加わるだけになる。
# 同じ前提は`release-develop-to-main.yml`のバンプPRの`--auto`にも効く。
#
# **なぜワークフローではなくローカルで実行するのか。** `WORKFLOW_PAT`の権限は
# Contents / Issues / Pull requests / Actions / Workflows / Metadata だけで、
# **Administration を持たない**（docs/organization-migration.md）。
# `PATCH /repos/{repo}`（`allow_auto_merge`）もブランチ保護APIも Administration: write が
# 要るため、ワークフローからは実行できない。`propagate-workflow-tag.sh`が`|| true`付きで
# 試し続けて一度も成功していなかったのが実例（12リポジトリ中8件が`false`のままだった）。
# ここはorg ownerである本人の`gh`で一度だけ実行する。
#
# **必須チェック名は推測しない。** ワークフローのジョブ名をそのまま必須にすると、実在しない
# 名前を要求して永久に埋まらず、マージ不能になる。CIワークフローのジョブ名のうち、
# **直近のdevelop向けPRで実際に成功したcheck run**と一致したものだけを使う。
#
# 使い方（既定はdry-run。実際に変更するには --apply を付ける）:
#   scripts/setup-develop-auto-merge.sh                       # 全対象を確認だけ
#   scripts/setup-develop-auto-merge.sh --apply               # 全対象へ適用
#   scripts/setup-develop-auto-merge.sh --apply car-care myroom  # リポジトリを絞る
set -uo pipefail

OWNER="guchi-apps"
APPLY=false
TARGETS=()

# **`gh api`は失敗時もエラーJSONを標準出力へ出す。** `2>/dev/null`だけでは変数へJSONが入り、
# 「取得できた」と誤って扱う（実際に「必須チェックは既にあります（{"message":"Branch not
# protected"...}）」と表示してしまった）。終了コードを見て、失敗なら何も返さない。
api() {
  local out
  out="$(gh api "$@" 2>/dev/null)" || return 1
  printf '%s' "$out"
}

for ARG in "$@"; do
  case "$ARG" in
    --apply) APPLY=true ;;
    -h | --help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "不明なオプション: $ARG" >&2
      exit 1
      ;;
    *) TARGETS+=("$ARG") ;;
  esac
done

# 対象を指定しなければ、`claude-issue-dispatch.yml`を持ちデフォルトブランチが`develop`の
# リポジトリを全部見る（無人実行を入れてある＝develop向けPRがIssue駆動で作られる範囲）
if [ "${#TARGETS[@]}" -eq 0 ]; then
  while read -r NAME; do
    [ -n "$NAME" ] || continue
    [ "$(api "repos/$OWNER/$NAME" --jq .default_branch)" = "develop" ] || continue
    api "repos/$OWNER/$NAME/contents/.github/workflows/claude-issue-dispatch.yml" \
      --jq .name >/dev/null || continue
    TARGETS+=("$NAME")
  done < <(gh repo list "$OWNER" --limit 100 --json name --jq '.[].name' | sort)
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "対象のリポジトリがありません。"
  exit 0
fi

[ "$APPLY" = "true" ] || echo "*** dry-run です。実際に変更するには --apply を付けてください ***"
echo

CHANGED=0
SKIPPED=0
FAILED=0

for NAME in "${TARGETS[@]}"; do
  REPO="$OWNER/$NAME"
  echo "== $REPO"

  # --- Allow auto-merge -----------------------------------------------------
  ALLOW="$(api "repos/$REPO" --jq '.allow_auto_merge')"
  if [ "$ALLOW" = "true" ]; then
    echo "  Allow auto-merge: 有効（変更なし）"
  elif [ "$APPLY" != "true" ]; then
    echo "  Allow auto-merge: 無効 → 有効にする"
  elif gh api -X PATCH "repos/$REPO" -F allow_auto_merge=true >/dev/null 2>&1; then
    echo "  Allow auto-merge: 有効にしました"
    CHANGED=$((CHANGED + 1))
  else
    echo "  FAIL Allow auto-merge を有効にできません（Administration: write が要ります）" >&2
    FAILED=$((FAILED + 1))
  fi

  # --- develop のブランチ保護 -----------------------------------------------
  # 保護が無いブランチでは404（＝`EXISTING`は空）。エラーJSONを名前として読まないこと
  EXISTING="$(api "repos/$REPO/branches/develop/protection" \
    --jq '[.required_status_checks.contexts[]?] | join(" ")')"
  if [ -n "$EXISTING" ]; then
    echo "  必須ステータスチェック: 既にあります（$EXISTING）。変更しません"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # CIワークフローのジョブ名。**CRLFのリポジトリがある**（asset-manager）ため CR を落とす。
  # `notify`は失敗時にだけ走るリポジトリがあるため必須にしない。
  CI_JOBS=""
  for FILE in ci.yml test.yml; do
    ENCODED="$(api "repos/$REPO/contents/.github/workflows/$FILE" --jq .content)" || continue
    BODY="$(printf '%s' "$ENCODED" | base64 -d 2>/dev/null)"
    [ -n "$BODY" ] || continue
    CI_JOBS="$(printf '%s' "$BODY" | tr -d '\r' \
      | awk '/^jobs:/ { injobs = 1; next } injobs && /^  [A-Za-z0-9_-]+:/ { sub(/:.*$/, ""); gsub(/ /, ""); print }' \
      | grep -vx notify | sort -u)"
    [ -n "$CI_JOBS" ] && break
  done

  # 直近のマージ済みdevelop向けPRのheadで、実際に成功したcheck runの名前。
  # skipped（パスフィルタ等で走らなかったジョブ）を必須にすると埋まらないままになる。
  SHA="$(api "repos/$REPO/pulls?base=develop&state=closed&per_page=20" \
    --jq 'map(select(.merged_at != null)) | .[0].head.sha // empty')"
  RUNS=""
  if [ -n "$SHA" ]; then
    RUNS="$(api "repos/$REPO/commits/$SHA/check-runs?per_page=100" \
      --jq '.check_runs[] | select(.conclusion == "success") | .name' | sort -u)"
  fi

  CONTEXTS=""
  if [ -n "$CI_JOBS" ] && [ -n "$RUNS" ]; then
    CONTEXTS="$(comm -12 <(printf '%s\n' "$CI_JOBS") <(printf '%s\n' "$RUNS") | tr '\n' ' ')"
    CONTEXTS="${CONTEXTS%% }"
  fi

  if [ -z "${CONTEXTS// /}" ]; then
    echo "  SKIP 必須チェックに使える名前を確認できません（CIのジョブ名と直近PRのcheck runが一致しない）" >&2
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ "$APPLY" != "true" ]; then
    echo "  必須ステータスチェック: なし → $CONTEXTS を必須にする"
    continue
  fi

  # 設定値はissue-deck・dayspanの`develop`と同じ（strict=false・レビュー必須なし）。
  # docs/organization-migration-checklist.md の手順と同じ形。
  if jq -n --arg names "$CONTEXTS" '{
        required_status_checks: { strict: false, contexts: ($names | split(" ") | map(select(. != ""))) },
        enforce_admins: false,
        required_pull_request_reviews: null,
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false
      }' | gh api -X PUT "repos/$REPO/branches/develop/protection" --input - >/dev/null 2>&1; then
    echo "  必須ステータスチェック: $CONTEXTS を設定しました"
    CHANGED=$((CHANGED + 1))
  else
    echo "  FAIL ブランチ保護を設定できません（Administration: write が要ります）" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo
echo "対象=${#TARGETS[@]} 変更=$CHANGED スキップ=$SKIPPED 失敗=$FAILED"
[ "$FAILED" -eq 0 ]
