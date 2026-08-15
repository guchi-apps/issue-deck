#!/usr/bin/env bash
# 並行状況スナップショット（#1215）。いま何が走っていて、どこが重なりうるかを1枚にする。
#
# 使い方:
#   scripts/fleet-status.sh                走っているセッション・未マージPR・重なりを表で出す
#   scripts/fleet-status.sh --json         同じ内容をJSONで出す（プロンプトへの差し込み用）
#   scripts/fleet-status.sh --no-fetch     origin の最新化を行わない（オフライン・速度優先）
#   scripts/fleet-status.sh --base main    突き合わせるベースブランチを変える（既定: develop）
#   scripts/fleet-status.sh --repo owner/name   対象リポジトリを変える（既定: guchi-apps/issue-deck）
#
# 環境変数:
#   ISSUE_DECK_REPO               対象リポジトリの既定値
#   ISSUE_DECK_SESSION_STATE_DIR  セッションの記述子の置き場（scripts/lib/session-state.sh）
#
# ## なぜ要るか
#
# **PRになる前の、走っているセッション同士の関係を見る実行体が1つも無い**
# （[docs/multi-agent/gates.md](../docs/multi-agent/gates.md)「セッションを横断して俯瞰する
# 実行体は無い」）。実際に #1200 の計画中に #1179・#1205 がdevelopへ入って前提が2回無効になり、
# #1179 が `start-local-session.sh` を分解した直後に #1180 が同じ起動経路を触る予定になった。
# どちらもPRになる前に気づけると安い。
#
# ## 作法
#
# **これは計器であって役ではない。** LLMを使わず決定的に作り、判断はしない。出すのは事実
# （何が走っていて、どのファイルが重なっているか）だけで、「やめろ」「待て」は言わない。
# 読むのはtmuxのメタデータ・git・GitHubの事実で、**画面（`capture-pane`）の内容は読まない**
# （画面の文字列から状態を推定する方式は実地で誤判定した実績がある。#1219・#1223）。
#
# **一次情報源はtmux。** 手元のターミナルから直接起動したセッションはissue-deckに存在しない
# （`DispatchJob`として残らない）ため、issue-deck側のジョブだけを見ると取りこぼす。
# その穴そのものは #1089 が別途扱う。
#
# **どの情報が取れなくても最後まで走る。** tmuxサーバーが起動していない・ghが未認証・
# ネットワークが無い、のいずれでも、取れたぶんだけを出して終える。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# セッション名からIssue・worktreeを引くための記述子。書く側（run-issue-session.sh）と共有する。
# shellcheck source=scripts/lib/session-state.sh
source "$SCRIPT_DIR/lib/session-state.sh"
# 整形と重なりの判定。**外部の状態を読まない純粋関数だけ**がこちらにある。
# shellcheck source=scripts/lib/fleet-status.sh
source "$SCRIPT_DIR/lib/fleet-status.sh"

REPO="${ISSUE_DECK_REPO:-guchi-apps/issue-deck}"
BASE_BRANCH="develop"
OUTPUT="table"
DO_FETCH=1

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      OUTPUT="json"
      shift
      ;;
    --no-fetch)
      DO_FETCH=0
      shift
      ;;
    --base)
      BASE_BRANCH="${2:-develop}"
      shift 2 || true
      ;;
    --repo)
      REPO="${2:-$REPO}"
      shift 2 || true
      ;;
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
done

REPO_NAME="${REPO##*/}"

ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "Error: gitリポジトリの中で実行してください。" >&2
  exit 1
fi

if [[ "$DO_FETCH" -eq 1 ]]; then
  # 先端が古いと「遅れ」も重なりの判定もずれる。**失敗しても続ける**（オフラインでも、
  # 手元にあるぶんの突き合わせには価値がある）。
  git -C "$ROOT" fetch origin "$BASE_BRANCH" --quiet 2>/dev/null || true
fi

RECORDS="$(mktemp)"
trap 'rm -f "$RECORDS"' EXIT

# --- ベースブランチの先端 ---
BASE_SHA="$(git -C "$ROOT" rev-parse "origin/$BASE_BRANCH" 2>/dev/null || true)"
BASE_SUBJECT="$(git -C "$ROOT" log -1 --format=%s "origin/$BASE_BRANCH" 2>/dev/null || true)"
printf 'base\t%s\t%s\t%s\t%s\n' "$BASE_BRANCH" "$BASE_SHA" "$BASE_SUBJECT" "$REPO" >>"$RECORDS"

# --- ブランチ → worktree のパス ---
# 記述子を持たないセッション（この仕組みより前から動いているもの・手で立てたもの）でも、
# ブランチ名からworktreeを引けるようにする。
declare -A WORKTREE_OF_BRANCH=()
while IFS=$'\t' read -r branch path; do
  [[ -n "$branch" && -n "$path" ]] || continue
  WORKTREE_OF_BRANCH["$branch"]="$path"
done < <(git -C "$ROOT" worktree list --porcelain 2>/dev/null | fleet_status_parse_worktrees || true)

# --- 走っているセッション ---
SELF_SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"

# そのworktreeが触っているファイルを列挙する（コミット済み＋未コミット＋未追跡）。
# `git status --porcelain` の行を切り出す形にしないのは、リネーム（`R old -> new`）と
# 引用符付きのパスで壊れるため。
worktree_changed_files() {
  local dir="$1" base_sha="$2"
  {
    if [[ -n "$base_sha" ]]; then
      git -C "$dir" diff --name-only "$base_sha..HEAD" 2>/dev/null || true
    fi
    git -C "$dir" diff --name-only HEAD 2>/dev/null || true
    git -C "$dir" ls-files --others --exclude-standard 2>/dev/null || true
  } | sort -u
}

worktree_dirty_files() {
  local dir="$1"
  {
    git -C "$dir" diff --name-only HEAD 2>/dev/null || true
    git -C "$dir" ls-files --others --exclude-standard 2>/dev/null || true
  } | sort -u
}

while IFS=$'\t' read -r session_name session_repo_name session_issue; do
  [[ -n "$session_name" ]] || continue

  repository=""
  worktree=""
  descriptor="$(session_state_descriptor_file "$session_name" 2>/dev/null || true)"
  if [[ -n "$descriptor" && -f "$descriptor" ]]; then
    repository="$(session_state_field "$descriptor" repository || true)"
    worktree="$(session_state_field "$descriptor" worktree || true)"
  fi

  # 記述子が無いセッションは、セッション名のリポジトリ名だけを頼りにする。owner が分からない
  # ため、**対象リポジトリと名前が一致したときだけ** owner/name へ復元する。取り違えると
  # 無関係なファイルを重なりとして出してしまう。
  if [[ -z "$repository" ]]; then
    if [[ "$session_repo_name" == "$REPO_NAME" ]]; then
      repository="$REPO"
    else
      repository="$session_repo_name"
    fi
  fi
  if [[ -z "$worktree" && "$repository" == "$REPO" ]]; then
    worktree="${WORKTREE_OF_BRANCH["issue-$session_issue"]:-}"
  fi
  # 横断質問セッション（#1454）はworktreeを持たない。記述子の値がもう無い場合も同じ扱い。
  if [[ -n "$worktree" && ! -d "$worktree" ]]; then
    worktree=""
  fi

  branch=""
  merge_base=""
  behind=""
  dirty=""
  self_flag=0
  [[ -n "$SELF_SESSION" && "$session_name" == "$SELF_SESSION" ]] && self_flag=1

  # **突き合わせるのは対象リポジトリのセッションだけ。** 別リポジトリのファイルパスは偶然
  # 一致しても衝突しないため、集めても重なりの判定には使えない（在庫としては表に出す）。
  if [[ -n "$worktree" && "$repository" == "$REPO" ]]; then
    branch="$(git -C "$worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    merge_base="$(git -C "$worktree" merge-base HEAD "origin/$BASE_BRANCH" 2>/dev/null || true)"
    if [[ -n "$merge_base" ]]; then
      behind="$(git -C "$worktree" rev-list --count "$merge_base..origin/$BASE_BRANCH" 2>/dev/null || true)"
    fi
    dirty="$(worktree_dirty_files "$worktree" | grep -c . || true)"
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      printf 'sfile\t%s\t%s\n' "$session_name" "$path" >>"$RECORDS"
    done < <(worktree_changed_files "$worktree" "$merge_base")
  fi

  printf 'session\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$session_name" "$repository" "$session_issue" "$worktree" \
    "$branch" "$merge_base" "$behind" "$dirty" "$self_flag" >>"$RECORDS"
done < <({ tmux list-sessions -F '#{session_name}' 2>/dev/null || true; } | fleet_status_parse_sessions || true)

# --- 未マージPR ---
{
  gh pr list --repo "$REPO" --base "$BASE_BRANCH" --state open \
    --json number,title,headRefName,files --limit 50 2>/dev/null || true
} | fleet_status_parse_prs >>"$RECORDS" || true

# --- 出力 ---
JSON="$(fleet_status_build_json <"$RECORDS")"
if [[ "$OUTPUT" == "json" ]]; then
  printf '%s\n' "$JSON"
else
  printf '%s\n' "$JSON" | fleet_status_render_table
fi
