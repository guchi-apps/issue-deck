#!/usr/bin/env bash
# 進捗ラベル（01.planning〜09.main）を対象リポジトリから削除する（#991 Phase 5・#1010）。
#
# 進捗はGitHub ProjectsのStatusが唯一の正になったため、ラベル定義そのものを消す。
# 条件系ラベル（00.check-user・21.plan-required等）は対象外で、そのまま残す。
#
# **実行はリリース後**。このスクリプトが消すラベルは、mainへ反映されるまでの間、本番の
# ワークフロー（reusable-issue-dispatch.ymlの実行モード判定・reusable-issue-labels.ymlの
# 対象issue検索）がまだ参照している。先に消すと、進行中のIssueの追加対応（mode=additional）
# やdevelop→mainの一括遷移が動かなくなる。順序は次のとおり。
#
#   1. #1010 を develop -> main へリリースし、本番へデプロイする（GET /api/progress が生える）
#   2. issue-deck のラベルを消す（--repo issue-deck）
#   3. dayspan・shopping-list は急がない。あちらの caller は workflows/v8 にタグ固定されており、
#      issue-deck の develop/main を進めても影響を受けない。**ラベルもあちらのリポジトリに
#      残ったまま**なので、v8 のワークフローは今までどおり動く。新しいタグ（workflows/v9）を
#      切って caller を更新したあとで、そのリポジトリのラベルを消す
#
# ラベルを消すと、そのラベルが付いていたIssueからは当然ラベルが外れる。**進捗はProjectの
# Statusに残る**ため情報は失われないが、盤面へ載っていないIssue（closed含む）は
# 「未着手」に見えるようになる。09.main が数百件に付いているのはそのため気に留めておく。
#
# **既定の対象は issue-deck だけ。** 他リポジトリは caller のタグを上げてから個別に指定する。
#
# 使い方:
#   scripts/remove-progress-labels.sh --dry-run                 # 既定。消す対象を出すだけ
#   scripts/remove-progress-labels.sh --apply                   # 実際に削除する
#   scripts/remove-progress-labels.sh --apply --repo dayspan    # 他リポジトリ（caller更新後）
#
# 前提: gh コマンドで認証済みであること。
set -euo pipefail

OWNER="guchi-apps"
DEFAULT_REPOS=(issue-deck)
PROGRESS_LABELS=("01.planning" "02.wip" "03.d:marge" "05.develop" "07.m:marge" "09.main")

apply=0
repos=()

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --dry-run) apply=0; shift ;;
    --repo) repos+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 1 ;;
  esac
done

if [ "${#repos[@]}" -eq 0 ]; then
  repos=("${DEFAULT_REPOS[@]}")
fi

if [ "$apply" -eq 0 ]; then
  echo "=== dry-run（--apply を付けると実際に削除します） ==="
fi

for repo in "${repos[@]}"; do
  echo "== $OWNER/$repo"
  existing="$(gh label list --repo "$OWNER/$repo" --json name --jq '.[].name' --limit 200)"
  for label in "${PROGRESS_LABELS[@]}"; do
    if ! printf '%s\n' "$existing" | grep -Fxq "$label"; then
      echo "  $label : 定義なし（スキップ）"
      continue
    fi
    if [ "$apply" -eq 1 ]; then
      gh label delete "$label" --repo "$OWNER/$repo" --yes
      echo "  $label : 削除しました"
    else
      echo "  $label : 削除対象"
    fi
  done
done

if [ "$apply" -eq 0 ]; then
  echo ""
  echo "実際に削除するには --apply を付けて再実行してください。"
fi
