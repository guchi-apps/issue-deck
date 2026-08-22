#!/usr/bin/env bash
# 既にコピーで増えてしまった worktree の `node_modules` を、ハードリンクへまとめ直す（#2124）。
#
# 使い方:
#   scripts/dedupe-node-modules.sh [--dry-run] [--yes] [--repo <owner/repo>] [--quiet]
#
#   --dry-run          回収できる量を測るだけで、ハードリンクは張らない
#   --yes / -y         確認プロンプトを出さずに実行する（無人実行はこれが必須）
#   --repo <owner/repo> 対象を1リポジトリに絞る（リポジトリ名だけでも可: --repo ops-dashboard）
#   --quiet            リポジトリごとの詳細を出さず、合計だけを出す
#
# ## なぜ要るか
#
# npm・yarnには pnpm のようなストア共有が無く、worktreeごとに `node_modules` の実体をコピーする。
# サブPCでは`~/apps`配下の`node_modules`が合計51.3GB（ルートFS 98GBの過半）まで膨らみ、
# 残り7GBを切った。`scripts/generic-start-issue.sh`が**これから作る**worktreeについては本体から
# ハードリンクで敷くようになったが（#2124）、**既にあるコピーはそのままでは減らない**。
# ここはその回収だけを持つ。
#
# 実測（dry-run・2026-08-22）の回収見込みは合計24.8GiB。
#   ops-dashboard 6.48GiB / db-console 4.02GiB / subscription-lists 3.69GiB /
#   asset-manager 3.57GiB / clip-hive 3.01GiB / car-care 1.72GiB / portfolio 1.29GiB /
#   aide 883MiB / meisai-lab 121MiB / shopping-list 53MiB
#
# ## 判断は挟まない
#
# 何をまとめてよいか（同名・同内容・同一所有者／パーミッション）は `hardlink`(util-linux) が
# 決め、何を外すかは `scripts/lib/node-modules-share.sh` が持つ。ここは「対象を列挙して呼ぶ」
# だけを持つ（docs/multi-agent/gates.md の「判断を挟まない計器」と同じ立て付け）。
#
# ## 走っているセッションと同時でも安全
#
# `hardlink` は置き換えを link+rename で行うため、開かれているファイルのディスクリプタは
# 元のinodeを掴んだままになる。まとめるのは**内容がsha256で一致したファイルだけ**なので、
# 読み側から見た内容も変わらない。
#
# 環境変数:
#   ISSUE_DECK_LOCAL_REPOS_CONFIG  リポジトリ対応表（既定: ~/.config/issue-deck/local-repos.conf）
#   ISSUE_DECK_DEDUPE_LOCK         多重起動を防ぐロックファイル

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# shellcheck source=scripts/lib/node-modules-share.sh
source "$SCRIPT_DIR/lib/node-modules-share.sh"

usage() {
  echo "Usage: scripts/dedupe-node-modules.sh [--dry-run] [--yes] [--repo <owner/repo>] [--quiet]"
}

DRY_RUN=0
ASSUME_YES=0
QUIET=0
TARGET_REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --quiet) QUIET=1 ;;
    --repo)
      shift
      TARGET_REPO="${1:-}"
      ;;
    --repo=*) TARGET_REPO="${1#*=}" ;;
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
  shift
done

if ! command -v hardlink >/dev/null 2>&1; then
  echo "Error: hardlink(1) が見つかりません（Ubuntuでは util-linux に含まれます）。" >&2
  exit 1
fi

if [[ "$DRY_RUN" -ne 1 && "$ASSUME_YES" -ne 1 && ! -t 0 ]]; then
  echo "非対話実行のため実行しません。実行する場合は --yes を付けてください。"
  exit 0
fi

# **多重起動を防ぐ。** 1回の走査は全リポジトリで15分前後かかるため、pollerの定期実行と手打ちが
# 重なりうる。重なると同じツリーを2つのプロセスが張り替え合い、無駄なだけでなく
# 「まとめた直後に相手が切る」形になる。
LOCK_FILE="${ISSUE_DECK_DEDUPE_LOCK:-${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck/dedupe-node-modules.lock}"
mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null || true
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "別のプロセスが node_modules を回収中のため、今回は何もしません。"
  exit 0
fi

# 対象リポジトリを絞る指定を、対応表のキー（owner/repo）へ寄せる。
# リポジトリ名だけを打たれることを想定し、末尾一致でも引く。
resolve_target_name() {
  local wanted="$1" name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ "$name" == "$wanted" || "${name##*/}" == "$wanted" ]]; then
      printf '%s\n' "$name"
      return 0
    fi
  done < <(local_repo_list_names)
  return 1
}

if [[ -n "$TARGET_REPO" ]]; then
  if ! TARGET_REPO="$(resolve_target_name "$TARGET_REPO")"; then
    echo "Error: 対応表に無いリポジトリです: $TARGET_REPO" >&2
    exit 1
  fi
fi

# 1リポジトリぶんの対象ディレクトリ（本体 + 全worktree）を集める。
# 2つ以上そろわなければ突き合わせる相手がいないので対象外。
collect_node_modules_dirs() {
  local repo_path="$1" dir
  [[ -d "$repo_path/node_modules" ]] && printf '%s\n' "$repo_path/node_modules"
  for dir in "$repo_path"-worktrees/*/node_modules; do
    [[ -d "$dir" ]] && printf '%s\n' "$dir"
  done
  return 0
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "=== node_modules の重複を測ります（--dry-run のため何も変更しません） ==="
else
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    echo "対象リポジトリの node_modules を走査し、内容が同じファイルをハードリンクへまとめます。"
    echo "全リポジトリだと15分前後かかります（--repo で1つに絞れます）。"
    read -r -p "実行しますか？ [y/N]: " answer
    case "$answer" in
      [yY] | [yY][eE][sS]) ;;
      *)
        echo "中止しました。"
        exit 0
        ;;
    esac
  fi
  echo "=== node_modules の重複をハードリンクへまとめます ==="
fi

processed=0
skipped=0
while IFS= read -r repo_name; do
  [[ -n "$repo_name" ]] || continue
  if [[ -n "$TARGET_REPO" && "$repo_name" != "$TARGET_REPO" ]]; then
    continue
  fi

  repo_path="$(local_repo_resolve_path "$repo_name" || true)"
  [[ -n "$repo_path" && -d "$repo_path" ]] || continue

  package_manager="$(detect_package_manager "$repo_path")"
  # pnpm・bunは自前のストアで共有済み。走らせても回収するものが無く、時間だけを使う。
  if ! node_modules_share_targets_pm "$package_manager"; then
    skipped=$((skipped + 1))
    continue
  fi

  mapfile -t dirs < <(collect_node_modules_dirs "$repo_path")
  if [[ "${#dirs[@]}" -lt 2 ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  echo "--- $repo_name（${#dirs[@]}本） ---"
  if [[ "$QUIET" -eq 1 ]]; then
    node_modules_share_dedupe "$DRY_RUN" "${dirs[@]}" | grep -E '^Saved:' || true
  else
    node_modules_share_dedupe "$DRY_RUN" "${dirs[@]}"
  fi
  processed=$((processed + 1))
done < <(local_repo_list_names)

echo "=== 対象 ${processed} リポジトリ・対象外 ${skipped} リポジトリ ==="
df -h / | tail -1
