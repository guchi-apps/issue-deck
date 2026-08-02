#!/usr/bin/env bash
# 任意のPNG画像をGitHub Issueコメントに埋め込むための仕組み（#255）。
#
# 画像を develop/main の祖先には含まれないorphanブランチ`screenshots`にコミット・pushし、
# raw.githubusercontent.com経由のURLを標準出力に1行1URLで出力する（公開リポジトリのため
# 認証なしで表示できる）。出力したURLはそのまま `gh issue comment` の本文に
# `![説明](URL)` の形で埋め込める。
#
# 使い方:
#   scripts/post-issue-screenshot.sh <issue番号> <画像ファイルパス> [画像ファイルパス...]
#
# 前提:
#   - gh コマンドで認証済みであること（`gh repo view`でリポジトリを解決する）
#   - git push できる権限があること。screenshotsブランチは.github/workflows/配下を含まないため、
#     GitHub Actions上では既定のGITHUB_TOKEN（contents: write権限）で足り、issue #106のような
#     workflow書き込み権限を持つPATは不要
#
# 画像は `issue-<issue番号>/<UTC日時>-<元のファイル名>` として保存する。ファイル名にタイムスタンプを
# 付けるのは、同名ファイルで撮り直した場合でもURLが変わり、raw.githubusercontent.com側の古い
# キャッシュを参照し続けないようにするため。
#
# 肥大化対策: Issueがクローズされた際、.github/workflows/issue-labels.ymlのcleanup-on-closeジョブが
# 対応する issue-<番号>/ ディレクトリをscreenshotsブランチから自動削除する。

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: scripts/post-issue-screenshot.sh <issue番号> <画像ファイルパス> [画像ファイルパス...]" >&2
  exit 1
fi

ISSUE_NUMBER="$1"
shift

if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: issue番号は数字で指定してください: $ISSUE_NUMBER" >&2
  exit 1
fi

for image in "$@"; do
  if [[ ! -f "$image" ]]; then
    echo "Error: 画像ファイルが見つかりません: $image" >&2
    exit 1
  fi
done

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh コマンドが見つかりません。" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
BRANCH="screenshots"
WORKTREE_DIR="$(mktemp -d)"

cleanup() {
  git -C "$ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  rm -rf "$WORKTREE_DIR"
}
trap cleanup EXIT

git -C "$ROOT" fetch origin "$BRANCH" >/dev/null 2>&1 || true

if git -C "$ROOT" show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  git -C "$ROOT" worktree add --quiet -B "$BRANCH" "$WORKTREE_DIR" "origin/$BRANCH"
else
  echo "情報: screenshotsブランチが存在しないため新規に作成します。" >&2
  git -C "$ROOT" worktree add --quiet --detach "$WORKTREE_DIR" HEAD
  (cd "$WORKTREE_DIR" && git checkout --orphan "$BRANCH" && git rm -rf . >/dev/null 2>&1)
fi

DEST_DIR="$WORKTREE_DIR/issue-$ISSUE_NUMBER"
mkdir -p "$DEST_DIR"

TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
URLS=()
for image in "$@"; do
  BASENAME="$(basename "$image")"
  DEST_NAME="${TIMESTAMP}-${BASENAME}"
  cp "$image" "$DEST_DIR/$DEST_NAME"
  URLS+=("https://raw.githubusercontent.com/$REPO/$BRANCH/issue-$ISSUE_NUMBER/$DEST_NAME")
done

(
  cd "$WORKTREE_DIR"
  git add "issue-$ISSUE_NUMBER"
  git -c user.name="Claude Code" -c user.email="claude-code@example.com" \
    commit --quiet -m "issue-$ISSUE_NUMBER のスクリーンショットを追加 #$ISSUE_NUMBER"
  git push --quiet origin "$BRANCH"
)

printf '%s\n' "${URLS[@]}"
