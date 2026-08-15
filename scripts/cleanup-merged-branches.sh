#!/usr/bin/env bash
# マージ済みの作業ブランチをGitHub上から削除する（#1478）。
#
# マージ後の作業ブランチが削除されず、issue-deckには670ブランチが溜まっていた。今後のぶんは
# リポジトリ設定 delete_branch_on_merge（scripts/set-delete-branch-on-merge.sh）が自動で消すが、
# 既に残っているぶんはこのスクリプトで掃除する。
#
# 使い方:
#   scripts/cleanup-merged-branches.sh                       # 既定。issue-deckをdry-run
#   scripts/cleanup-merged-branches.sh --repo dayspan        # 対象を絞る（複数指定可）
#   scripts/cleanup-merged-branches.sh --all-repos           # 非forkの全リポジトリ
#   scripts/cleanup-merged-branches.sh --apply --yes         # 実際に削除する
#
# オプション:
#   --apply                実際に削除する（既定はdry-run）
#   --repo <name>          対象リポジトリ（複数指定可。既定: issue-deck）
#   --all-repos            非fork・非archiveの全リポジトリを対象にする
#   --yes / -y             削除前の確認プロンプトを出さない
#   --include-open-issues  対応Issueがopenのブランチも削除対象に含める（既定は除外）
#   --log <path>           削除ログの出力先（既定: ~/.local/state/issue-deck/deleted-branches.tsv）
#   --owner <owner>        対象owner（既定: guchi-apps）
#
# 次をすべて満たすブランチだけを削除する。1つでも欠けたら残す。
#
#   1. 名前が保護対象でない
#      main / develop / master / そのリポジトリのデフォルトブランチ /
#      screenshots（#255のorphanブランチ。scripts/post-issue-screenshot.sh が使う） /
#      GitHub上で protected: true
#   2. そのブランチをheadとするPRが1件以上あり、最新のPRがマージ済み
#   3. openなPRのheadでない
#   4. ブランチの現在のSHAが、そのマージ済みPRの head.sha と一致する
#      （＝マージ後にコミットが積まれていない。同名ブランチで作業を再開した場合はここで外れる）
#   5. issue-<番号> 形式なら、そのIssueがopenでない（--include-open-issues で解除）
#
# **`develop` は develop→main のPRのheadなので、条件2〜4だけでは削除対象に入る。**
# 条件1の名前による保護が最後の砦になっている。ここを緩めないこと。
#
# 条件5がある理由: 無人実行のmode判定（.github/workflows/reusable-issue-dispatch.yml）は
# リモートブランチの存在を見ており、「ブランチがある＋develop向けPRがOPENでない」ときは
# mode=skip で何もしない。ブランチを消すとその分岐を抜けて、developから新規ブランチを切って
# 実装が始まる。closedなIssueは手前のissue_closed判定で弾かれるが、openなIssue（Release待ちなど）
# は挙動が変わるため、既定では残す。
#
# 削除したブランチはログ（TSV）に残るので、消したあとでも次のコマンドで復元できる。
#
#   git push origin <SHA>:refs/heads/<ブランチ名>
#
# 前提: gh コマンドで認証済みであること。
set -euo pipefail

OWNER="${ISSUE_DECK_GH_OWNER:-guchi-apps}"
DEFAULT_REPOS=(issue-deck)
# 名前で無条件に保護するブランチ。リポジトリのデフォルトブランチは実行時に追加する。
PROTECTED_NAMES=(main develop master screenshots)
DEFAULT_LOG="${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck/deleted-branches.tsv"

apply=0
assume_yes=0
include_open_issues=0
all_repos=0
log_path="$DEFAULT_LOG"
repos=()

usage() {
  sed -n '2,25p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --dry-run) apply=0; shift ;;
    --repo) repos+=("$2"); shift 2 ;;
    --repo=*) repos+=("${1#*=}"); shift ;;
    --all-repos) all_repos=1; shift ;;
    --yes|-y) assume_yes=1; shift ;;
    --include-open-issues) include_open_issues=1; shift ;;
    --log) log_path="$2"; shift 2 ;;
    --log=*) log_path="${1#*=}"; shift ;;
    --owner) OWNER="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不明な引数: $1" >&2; usage >&2; exit 1 ;;
  esac
done

for cmd in gh jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "エラー: ${cmd} コマンドが見つかりません" >&2
    exit 1
  fi
done

if [ "$all_repos" -eq 1 ]; then
  if [ "${#repos[@]}" -gt 0 ]; then
    echo "エラー: --all-repos と --repo は同時に指定できません" >&2
    exit 1
  fi
  mapfile -t repos < <(
    gh repo list "$OWNER" --limit 200 --json name,isFork,isArchived \
      --jq '.[] | select(.isFork | not) | select(.isArchived | not) | .name' | sort
  )
fi

if [ "${#repos[@]}" -eq 0 ]; then
  repos=("${DEFAULT_REPOS[@]}")
fi

total_targets=0
total_deleted=0
total_failed=0

# 1リポジトリぶんの判定と削除を行う。
cleanup_repo() {
  local repo="$1"
  echo "== $OWNER/$repo"

  local default_branch
  default_branch="$(gh api "repos/$OWNER/$repo" --jq '.default_branch' 2>/dev/null || true)"
  if [ -z "$default_branch" ]; then
    echo "  リポジトリ情報を取得できませんでした。スキップします。"
    total_failed=$((total_failed + 1))
    return 0
  fi

  local branches_tsv prs_tsv open_issues
  branches_tsv="$(gh api "repos/$OWNER/$repo/branches?per_page=100" --paginate \
    --jq '.[] | [.name, .commit.sha, (.protected | tostring)] | @tsv')"
  prs_tsv="$(gh api "repos/$OWNER/$repo/pulls?state=all&per_page=100" --paginate \
    --jq '.[] | [(.number | tostring), .head.ref, .head.sha, (.merged_at // "-"), .state] | @tsv')"
  if [ "$include_open_issues" -eq 1 ]; then
    open_issues=""
  else
    open_issues="$(gh api "repos/$OWNER/$repo/issues?state=open&per_page=100" --paginate \
      --jq '.[] | select(.pull_request == null) | .number' || true)"
  fi

  # ブランチごとに「最新のPR」を1件だけ覚える。PR番号が大きいものを最新とみなす。
  local -A latest_num=() latest_sha=() latest_merged=() has_open_pr=() is_open_issue=()
  local num ref sha merged state
  while IFS=$'\t' read -r num ref sha merged state; do
    if [ -z "${ref:-}" ]; then continue; fi
    if [ "$state" = "open" ]; then has_open_pr["$ref"]=1; fi
    if [ "${num}" -gt "${latest_num[$ref]:-0}" ]; then
      latest_num["$ref"]="$num"
      latest_sha["$ref"]="$sha"
      latest_merged["$ref"]="$merged"
    fi
  done <<< "$prs_tsv"

  local n
  while read -r n; do
    if [ -z "${n:-}" ]; then continue; fi
    is_open_issue["$n"]=1
  done <<< "$open_issues"

  local -a targets=()
  local skip_protected=0 skip_no_pr=0 skip_not_merged=0 skip_advanced=0 skip_open_issue=0
  local -a advanced_names=() not_merged_names=() no_pr_names=() open_issue_names=()

  local name protected issue_no
  while IFS=$'\t' read -r name sha protected; do
    if [ -z "${name:-}" ]; then continue; fi

    # 条件1: 名前・保護設定による保護
    if [ "$name" = "$default_branch" ] || [ "$protected" = "true" ] \
      || printf '%s\n' "${PROTECTED_NAMES[@]}" | grep -Fxq -- "$name"; then
      skip_protected=$((skip_protected + 1))
      continue
    fi

    # 条件2: PRが1件も無い
    if [ -z "${latest_num[$name]:-}" ]; then
      skip_no_pr=$((skip_no_pr + 1))
      no_pr_names+=("$name")
      continue
    fi

    # 条件2・3: 最新のPRがマージされていない（openなPRのheadもここで外れる）
    if [ "${latest_merged[$name]}" = "-" ] || [ -n "${has_open_pr[$name]:-}" ]; then
      skip_not_merged=$((skip_not_merged + 1))
      not_merged_names+=("$name (#${latest_num[$name]})")
      continue
    fi

    # 条件4: マージ後にコミットが積まれている
    if [ "${latest_sha[$name]}" != "$sha" ]; then
      skip_advanced=$((skip_advanced + 1))
      advanced_names+=("$name (#${latest_num[$name]})")
      continue
    fi

    # 条件5: 対応Issueがopen
    if [[ "$name" =~ ^issue-([0-9]+) ]]; then
      issue_no="${BASH_REMATCH[1]}"
      if [ -n "${is_open_issue[$issue_no]:-}" ]; then
        skip_open_issue=$((skip_open_issue + 1))
        open_issue_names+=("$name")
        continue
      fi
    fi

    targets+=("$name"$'\t'"$sha"$'\t'"${latest_num[$name]}")
  done <<< "$branches_tsv"

  local branch_count
  branch_count="$(printf '%s\n' "$branches_tsv" | grep -c . || true)"
  echo "  ブランチ ${branch_count}件 → 削除対象 ${#targets[@]}件"
  echo "    残す: 保護 ${skip_protected}件 / PR無し ${skip_no_pr}件 / 未マージ ${skip_not_merged}件 / マージ後に進行 ${skip_advanced}件 / Issueがopen ${skip_open_issue}件"
  if [ "$skip_no_pr" -gt 0 ]; then echo "      PR無し: ${no_pr_names[*]}"; fi
  if [ "$skip_not_merged" -gt 0 ]; then echo "      未マージ: ${not_merged_names[*]}"; fi
  if [ "$skip_advanced" -gt 0 ]; then echo "      マージ後に進行: ${advanced_names[*]}"; fi
  if [ "$skip_open_issue" -gt 0 ]; then echo "      Issueがopen: ${open_issue_names[*]}"; fi

  if [ "${#targets[@]}" -eq 0 ]; then
    echo "  削除対象はありません。"
    echo
    return 0
  fi

  total_targets=$((total_targets + ${#targets[@]}))

  echo "  削除対象（先頭20件）:"
  local i shown=0
  for i in "${targets[@]}"; do
    if [ "$shown" -ge 20 ]; then break; fi
    echo "    ${i%%$'\t'*}"
    shown=$((shown + 1))
  done
  if [ "${#targets[@]}" -gt 20 ]; then echo "    ... 他 $(( ${#targets[@]} - 20 ))件"; fi

  if [ "$apply" -eq 0 ]; then
    echo "  （dry-run。実際に削除するには --apply を付けてください）"
    echo
    return 0
  fi

  if [ "$assume_yes" -eq 0 ]; then
    if [ ! -t 0 ]; then
      echo "エラー: 対話端末ではないため確認が取れません。--yes を付けて実行してください。" >&2
      exit 1
    fi
    local answer
    read -r -p "  $OWNER/$repo の ${#targets[@]}件を削除します。よろしいですか？ [yes/N] " answer
    if [ "$answer" != "yes" ]; then
      echo "  中止しました。"
      echo
      return 0
    fi
  fi

  mkdir -p "$(dirname "$log_path")"
  if [ ! -s "$log_path" ]; then
    printf 'deleted_at\trepository\tbranch\tsha\tpr_number\n' >> "$log_path"
  fi

  local now branch pr deleted=0 failed=0 done_count=0
  now="$(date -Iseconds)"
  for i in "${targets[@]}"; do
    IFS=$'\t' read -r branch sha pr <<< "$i"
    if gh api -X DELETE "repos/$OWNER/$repo/git/refs/heads/$branch" >/dev/null 2>&1; then
      printf '%s\t%s/%s\t%s\t%s\t%s\n' "$now" "$OWNER" "$repo" "$branch" "$sha" "$pr" >> "$log_path"
      deleted=$((deleted + 1))
    else
      echo "    削除に失敗: $branch"
      failed=$((failed + 1))
    fi
    done_count=$((done_count + 1))
    if [ $((done_count % 50)) -eq 0 ]; then
      echo "    ${done_count}/${#targets[@]}件 処理しました"
    fi
  done

  total_deleted=$((total_deleted + deleted))
  total_failed=$((total_failed + failed))
  echo "  削除: ${deleted}件 / 失敗: ${failed}件"
  echo
}

if [ "$apply" -eq 0 ]; then
  echo "=== dry-run（--apply を付けると実際に削除します） ==="
fi
echo "owner: $OWNER / 対象リポジトリ: ${repos[*]}"
echo

for repo in "${repos[@]}"; do
  cleanup_repo "$repo"
done

if [ "$apply" -eq 1 ]; then
  echo "合計: 削除 ${total_deleted}件 / 失敗 ${total_failed}件"
  if [ "$total_deleted" -gt 0 ]; then
    echo "削除ログ: $log_path"
    echo "復元するには: git push origin <SHA>:refs/heads/<ブランチ名>"
  fi
else
  echo "合計: 削除対象 ${total_targets}件"
fi

[ "$total_failed" -eq 0 ]
