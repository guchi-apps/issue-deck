#!/usr/bin/env bash
# マージ時にheadブランチを自動削除する設定（delete_branch_on_merge）を横断で有効化する（#1478）。
#
# この設定が無効だと、developへPRをマージしても作業ブランチ（issue-<番号>）が残り続ける。
# issue-deckでは670ブランチまで溜まっていた。有効にすると、GitHub上でマージした時点で
# headブランチが自動的に消える。
#
# **ローカルのworktree運用には影響しない。** 消えるのはリモートのブランチだけで、ローカルの
# worktree・ブランチはそのまま残る（掃除は scripts/cleanup-worktrees.sh の担当）。
# ただし無人実行のmode判定には影響する（scripts/cleanup-merged-branches.sh の冒頭を参照）。
#
# 使い方:
#   scripts/set-delete-branch-on-merge.sh                      # 既定。dry-run（対象を出すだけ）
#   scripts/set-delete-branch-on-merge.sh --apply              # 非forkの全リポジトリへ適用
#   scripts/set-delete-branch-on-merge.sh --apply --repo dayspan   # 対象を絞る（複数指定可）
#
# 対象は `gh repo list` が返す非fork・非archiveのリポジトリすべて。forkはupstream側の運用に
# 従うべきなので触らない。archiveされたリポジトリは設定変更そのものが拒否される。
#
# 前提: gh コマンドで認証済みであること。
set -euo pipefail

OWNER="${ISSUE_DECK_GH_OWNER:-guchi-apps}"

apply=0
repos=()

usage() {
  sed -n '2,26p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --dry-run) apply=0; shift ;;
    --repo) repos+=("$2"); shift 2 ;;
    --repo=*) repos+=("${1#*=}"); shift ;;
    --owner) OWNER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不明な引数: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "エラー: gh コマンドが見つかりません" >&2
  exit 1
fi

if [ "${#repos[@]}" -eq 0 ]; then
  # 非fork・非archiveのリポジトリを対象にする。
  mapfile -t repos < <(
    gh repo list "$OWNER" --limit 200 --json name,isFork,isArchived \
      --jq '.[] | select(.isFork | not) | select(.isArchived | not) | .name' | sort
  )
fi

if [ "${#repos[@]}" -eq 0 ]; then
  echo "対象リポジトリがありません。" >&2
  exit 1
fi

if [ "$apply" -eq 0 ]; then
  echo "=== dry-run（--apply を付けると実際に設定を変更します） ==="
fi
echo "owner: $OWNER / 対象: ${#repos[@]}件"
echo

changed=0
already=0
failed=0

for repo in "${repos[@]}"; do
  current="$(gh api "repos/$OWNER/$repo" --jq '.delete_branch_on_merge' 2>/dev/null || echo "error")"
  case "$current" in
    error)
      echo "  $repo : 取得できませんでした（権限・リポジトリ名を確認してください）"
      failed=$((failed + 1))
      continue
      ;;
    true)
      echo "  $repo : 既に有効（変更なし）"
      already=$((already + 1))
      continue
      ;;
  esac

  if [ "$apply" -eq 1 ]; then
    if gh api -X PATCH "repos/$OWNER/$repo" -F delete_branch_on_merge=true >/dev/null 2>&1; then
      echo "  $repo : 有効にしました"
      changed=$((changed + 1))
    else
      echo "  $repo : 変更に失敗しました（archive済み・権限不足の可能性）"
      failed=$((failed + 1))
    fi
  else
    echo "  $repo : 有効にする対象"
    changed=$((changed + 1))
  fi
done

echo
if [ "$apply" -eq 1 ]; then
  echo "有効化: ${changed}件 / 既に有効: ${already}件 / 失敗: ${failed}件"
else
  echo "有効化する対象: ${changed}件 / 既に有効: ${already}件 / 取得できず: ${failed}件"
  echo "実際に変更するには --apply を付けて再実行してください。"
fi

[ "$failed" -eq 0 ]
