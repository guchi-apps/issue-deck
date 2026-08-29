#!/usr/bin/env bash
# マージ済みIssueのworktree・ブランチを掃除する（#1100）
#
# 使い方:
#   scripts/cleanup-worktrees.sh [--dry-run] [--yes] [--issue <番号>] [--no-fetch] [--force] [--size]
#                                [--min-age-minutes <分>] [--keep-next]
#                                [--repo <owner/repo> | --all-repos]
#
#   --dry-run       判定結果を表示するだけで削除しない
#   --yes / -y      確認プロンプトを出さずに削除する
#   --issue <番号>  対象を1つのIssueに絞る
#   --no-fetch      マージ先ブランチの最新化（git fetch）を行わない
#   --force         未コミットの変更・未pushのコミットを無視して削除する（--issue 必須）
#   --size          削除対象のディスク使用量を測って表示する（既定では測らない）
#   --min-age-minutes <分>
#                   起動の準備からこの分数が経っていないworktreeは触らない（既定30・0で無効）。
#                   --issue で1件に絞ったときは効かない（明示的な指定を優先する）
#   --keep-next     残すworktreeの `.next` を削除しない
#   --repo <owner/repo>
#                   対象リポジトリ（既定 guchi-apps/issue-deck）。チェックアウト先は
#                   `~/.config/issue-deck/local-repos.conf` から引く
#   --all-repos     対応表に載っている全リポジトリを順に掃除する（--issue・--force とは併用不可）
#
# ## issue-deck専用ではない（#2123）
#
# 汎用ランチャー（scripts/generic-start-issue.sh）は`~/apps/<repo>-worktrees/issue-<番号>`へ
# 他リポジトリのworktreeを作るのに、掃除はissue-deckの置き場しか見ていなかった。他リポジトリ側に
# 掃除スクリプトを持つリポジトリは1つも無く、**起点がどこにも無いまま153本が溜まって**
# サブPCのルートFSが91%に達した（#1716のissue-deck版がそのまま他リポジトリで再発した形）。
#
# 判定（未コミットの変更・未pushのコミット・セッション稼働中・経過時間）はリポジトリによらず
# 同じなので、**リポジトリごとに変わるものだけを引数と設定から解決する**。
#
#   チェックアウト先    scripts/lib/local-repo-resolve.sh（`local-repos.conf`）
#   worktreeの置き場    ~/apps/<repo>-worktrees（汎用ランチャーと同じ規約）
#   マージ先のブランチ  実在する origin/develop・origin/main・origin/master（worktree_base_refs）
#   マージ済みPRの取得  gh pr list --repo <owner/repo>
#   開発サーバーのポート帯  scripts/local-repo-ports.conf
#
# `--all-repos` は自分自身を`--repo`付きで順に呼ぶ。**1リポジトリの失敗で残りを止めない**
# （fetchできないcloneが1つあるだけで他が掃除されなくなる方が困る）。
#
# 次をすべて満たすworktreeだけを削除対象にする。1つでも欠けたら残す。
#   - 未コミットの変更が無い
#   - マージ先のブランチ（origin/develop・origin/main のうち実在するもの）に入っていない
#     コミットが無い（未pushの作業が無い）
#   - そのIssueのセッション・開発サーバーが動いていない
#   - ブランチ issue-<番号> を開いていて、gitの作業ツリーとして壊れていない
#   - このスクリプトを実行しているworktreeでない
#
# **「PRがマージ済みか」は判定に使わない**（#1192）。消して失われるものが無いことは上の2つで
# 決まり、PRの有無はそこへ何も足さない（マージ先に入っていないコミットが1つでもあれば必ず残る）。
# 逆にPRを条件にすると、PRが最初から作られないworktree（起動確認だけして終わった・実作業が
# 別リポジトリだった・セッションが途中で落ちた・Issueが取り下げられた）が永久に消せなくなる。
# マージ済みPRの番号は削除理由の表示にだけ使う。
#
# それでも消せないもの（未コミットの変更が残っている等）は `--issue <番号> --force` で消す。
# 何が失われるかを表示してから削除する。ただしセッションが動いている・別ブランチを開いている
# ものは --force でも消さない（失われるのではなく壊れるため）。
#
# 削除するのは worktree・ローカルブランチ・そのIssue用の生成物（起動用プロンプト、
# 開発サーバーのログ・PIDファイル）まで。リモートブランチには触れない。
#
# **残すworktreeの `.next` は削除する**（#1716）。ビルド成果物なので消しても失われるものが無く、
# 次に `pnpm dev` / `pnpm build` を打てば作り直される。実測でサブPCの worktree 163本が
# `.next/dev`（Turbopackのdevキャッシュ）だけで16GB、`.next`全体で25GB・1本あたり最大679MBを
# 抱えていた。消して無くなるworktreeのぶんは削除で一緒に消えるので、ここで効くのは
# **未pushのコミットや未コミットの変更を抱えて長く残るworktree**。`--keep-next`で止められる。
#
# **`--min-age-minutes`（既定30分）は無人実行のための安全弁**（#1716）。上の判定はどれも
# 「いま何かが動いているか」を見ておらず、`start-issue.sh`がworktreeを作ってからセッションの
# プロセスが立つまでの数分間は削除対象の条件をすべて満たしてしまう（`pnpm install`が置くのは
# `.gitignore`対象のファイルだけなので、未コミットの変更として数えられない）。人が手で
# 打っていた頃はその瞬間に当たる確率が低かったが、定期実行では毎時ぶつかりに行く。
#
# **worktreeが100件を超えても数十秒で終わること**を前提に書く（#1680）。1件ずつ `gh` を叩き、
# 1件ずつ `du` でサイズを測っていた頃は170件で4分以上かかり、その間1行も出力しないため
# `--dry-run` が固まったようにしか見えなかった。worktreeの数に比例して増える処理を足すときは、
# まとめて1回で引けないか・進捗を出せるかを先に考える。
#
# 環境変数:
#   ISSUE_DECK_WORKTREE_BASE           issue-deckのworktreeの置き場所（既定: ~/apps/issue-deck-worktrees）
#   ISSUE_DECK_GH_TIMEOUT              gh の1回の呼び出しに被せる制限時間・秒（既定: 60）
#   ISSUE_DECK_CLEANUP_MIN_AGE_MINUTES --min-age-minutes の既定値（既定: 30）
#   ISSUE_DECK_CLEANUP_FETCH_TIMEOUT   1リポジトリのfetchに被せる制限時間・秒（既定: 60）

set -euo pipefail

# **`ROOT` はこのスクリプトが置かれているチェックアウト（issue-deck）で、掃除の対象とは別**
# （#2123）。対象リポジトリのチェックアウトは `REPO_ROOT` に入る。混ぜると、他リポジトリの
# 掃除中に「このスクリプト自身が置かれているworktree」の判定が効かなくなる。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$ROOT/scripts/cleanup-worktrees.sh"

# shellcheck source=scripts/lib/worktree-status.sh
source "$ROOT/scripts/lib/worktree-status.sh"
# worktreeを消す前に開発サーバーを止める（#1524）。止め方は run-issue-session.sh・
# reap-dev-servers.sh と共有する。
# shellcheck source=scripts/lib/dev-server.sh
source "$ROOT/scripts/lib/dev-server.sh"
# チェックアウト先・ポート帯の解決は起動側（start-local-session.sh・generic-start-issue.sh）と
# 共有する（#2123）。**掃除だけが別の対応表を持つと、起こした場所と消す場所がずれる。**
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$ROOT/scripts/lib/local-repo-resolve.sh"

DEFAULT_REPO="$ISSUE_DECK_REPO"

usage() {
  echo "Usage: scripts/cleanup-worktrees.sh [--dry-run] [--yes] [--issue <番号>] [--no-fetch] [--force] [--size]"
  echo "                                    [--min-age-minutes <分>] [--keep-next]"
  echo "                                    [--repo <owner/repo> | --all-repos]"
}

# 対象リポジトリのworktreeの置き場。**汎用ランチャーと同じ規約**（~/apps/<repo>-worktrees）で
# 決める（#2123）。issue-deckだけは従来どおり ISSUE_DECK_WORKTREE_BASE で差し替えられる。
worktree_base_for_repo() {
  local full_name="$1" repo="${1#*/}"
  if [[ "$full_name" == "$DEFAULT_REPO" && -n "${ISSUE_DECK_WORKTREE_BASE:-}" ]]; then
    printf '%s' "$ISSUE_DECK_WORKTREE_BASE"
    return 0
  fi
  printf '%s' "$HOME/apps/$repo-worktrees"
}

DRY_RUN=0
ASSUME_YES=0
DO_FETCH=1
FORCE=0
SHOW_SIZE=0
PRUNE_NEXT=1
TARGET_ISSUE=""
TARGET_REPO=""
ALL_REPOS=0
MIN_AGE_MINUTES="${ISSUE_DECK_CLEANUP_MIN_AGE_MINUTES:-30}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-fetch) DO_FETCH=0 ;;
    --force) FORCE=1 ;;
    --size) SHOW_SIZE=1 ;;
    --keep-next) PRUNE_NEXT=0 ;;
    --min-age-minutes) shift; MIN_AGE_MINUTES="${1:-}" ;;
    --min-age-minutes=*) MIN_AGE_MINUTES="${1#*=}" ;;
    --issue) shift; TARGET_ISSUE="${1:-}" ;;
    --issue=*) TARGET_ISSUE="${1#*=}" ;;
    --repo) shift; TARGET_REPO="${1:-}" ;;
    --repo=*) TARGET_REPO="${1#*=}" ;;
    --all-repos) ALL_REPOS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Error: 不明な引数です: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ -n "$TARGET_ISSUE" && ! "$TARGET_ISSUE" =~ ^[0-9]+$ ]]; then
  echo "Error: --issue は数字で指定してください: $TARGET_ISSUE" >&2
  exit 1
fi

if [[ -n "$TARGET_REPO" && ! "$TARGET_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "Error: --repo は owner/repo の形式で指定してください: $TARGET_REPO" >&2
  exit 1
fi

# `--all-repos` は「全リポジトリを順に回す」だけの指定で、1件を狙う指定とは意味が両立しない。
if [[ "$ALL_REPOS" -eq 1 ]]; then
  if [[ -n "$TARGET_REPO" ]]; then
    echo "Error: --all-repos と --repo は同時に指定できません。" >&2
    exit 1
  fi
  if [[ -n "$TARGET_ISSUE" || "$FORCE" -eq 1 ]]; then
    echo "Error: --all-repos は --issue・--force と同時に指定できません（対象を1件に絞る指定と両立しません）。" >&2
    exit 1
  fi
fi

if [[ ! "$MIN_AGE_MINUTES" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "Error: --min-age-minutes は0以上の整数で指定してください: $MIN_AGE_MINUTES" >&2
  exit 1
fi

# **1件に絞ったときは経過時間を見ない**（#1716）。番号を打った人は対象を分かって指定しており、
# 「30分待ってください」と返すのは邪魔にしかならない。安全弁が要るのは全件を無人で回す側。
if [[ -n "$TARGET_ISSUE" ]]; then
  MIN_AGE_MINUTES=0
fi

# --force は必ず1件に絞って使う。全件へ効く強制削除は、判定を1つ間違えただけで並行して
# 走っている他セッションの作業ごと消えるため作らない（#1192）。
if [[ "$FORCE" -eq 1 && -z "$TARGET_ISSUE" ]]; then
  echo "Error: --force は --issue <番号> と一緒に指定してください（消す対象を1件に限定するため）。" >&2
  usage >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh コマンドが見つかりません。" >&2
  exit 1
fi

# --- 全リポジトリを順に掃除する（#2123）--------------------------------------
# 自分自身を `--repo` 付きで呼ぶ。**判定のループを二重に持たない**（in-processで回すには
# 判定結果を貯める配列を毎回リセットする必要があり、消し忘れが起きた側が単独で事故になる）。
#
# **1リポジトリの失敗で残りを止めない。** fetchできないclone・未認証の`gh`が1つあるだけで
# 他のリポジトリが永久に掃除されなくなるのが、そもそもこのIssueの状態。
if [[ "$ALL_REPOS" -eq 1 ]]; then
  # **`[[ ... ]] && arr+=(...)` では書かない。** 条件が偽のときのAND-ORリストは `set -e` の
  # 対象外なので今は動くが、並べ替えでブロックの末尾に来た瞬間に「1を返して抜ける」に化ける。
  child_args=()
  if [[ "$DRY_RUN" -eq 1 ]]; then child_args+=(--dry-run); fi
  if [[ "$ASSUME_YES" -eq 1 ]]; then child_args+=(--yes); fi
  if [[ "$DO_FETCH" -eq 0 ]]; then child_args+=(--no-fetch); fi
  if [[ "$SHOW_SIZE" -eq 1 ]]; then child_args+=(--size); fi
  if [[ "$PRUNE_NEXT" -eq 0 ]]; then child_args+=(--keep-next); fi
  child_args+=(--min-age-minutes "$MIN_AGE_MINUTES")

  all_failed=()
  all_done=0
  all_skipped=0
  while IFS= read -r repo_name; do
    [[ -n "$repo_name" ]] || continue
    if ! repo_path="$(local_repo_resolve_path "$repo_name")"; then
      all_skipped=$((all_skipped + 1))
      continue
    fi
    if ! git -C "$repo_path" rev-parse --git-dir >/dev/null 2>&1; then
      all_skipped=$((all_skipped + 1))
      continue
    fi
    repo_base="$(worktree_base_for_repo "$repo_name")"
    if [[ ! -d "$repo_base" ]]; then
      # worktreeを1本も作ったことがないリポジトリ。掃除するものが無い。
      all_skipped=$((all_skipped + 1))
      continue
    fi
    echo ""
    echo "########## $repo_name（$repo_base） ##########"
    all_done=$((all_done + 1))
    if ! bash "$SELF" --repo "$repo_name" "${child_args[@]}"; then
      all_failed+=("$repo_name")
    fi
  done < <(local_repo_list_names)

  echo ""
  echo "=== 全リポジトリの掃除が終わりました ==="
  echo "  走査: ${all_done}リポジトリ / 対象外: ${all_skipped}リポジトリ（チェックアウトかworktreeの置き場が無い）"
  if [[ ${#all_failed[@]} -gt 0 ]]; then
    echo "  失敗: ${all_failed[*]}" >&2
    exit 1
  fi
  exit 0
fi

# --- 対象リポジトリの解決 -----------------------------------------------------
TARGET_REPO="${TARGET_REPO:-$DEFAULT_REPO}"

# issue-deck自身は**このスクリプトが置かれているチェックアウト**を使う。対応表のパスへ
# 寄せてしまうと、worktreeから実行したときに「自分の足元」の判定が効かなくなる。
if [[ "$TARGET_REPO" == "$DEFAULT_REPO" ]]; then
  REPO_ROOT="$ROOT"
elif ! REPO_ROOT="$(local_repo_resolve_path "$TARGET_REPO")"; then
  echo "Error: $TARGET_REPO のローカルチェックアウト先が分かりません（$(local_repos_config_file)）。" >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: $TARGET_REPO のチェックアウトがgitリポジトリではありません: $REPO_ROOT" >&2
  exit 1
fi

WORKTREE_BASE="$(worktree_base_for_repo "$TARGET_REPO")"
PROMPT_DIR="$WORKTREE_BASE/.prompts"
DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"
SAFE_REPO="${TARGET_REPO#*/}"
SAFE_REPO="${SAFE_REPO//[^A-Za-z0-9_-]/-}"

# 開発サーバーのポート帯（#2123）。**引けなければ止めに行かない。** 既定値（issue-deckの4000）へ
# 落ちると、他リポジトリの掃除で issue-deck の同じ番号のポートを撃ちに行くことになる
# （`dev_server_stop_by_port` はcwdも見るので実害は出ないが、そもそも渡さないのが正しい）。
DEV_PORT_BASE="$(local_repo_port_base "$TARGET_REPO" || true)"
# 帯の幅（#2478）。「ベース値 + Issue番号」は帯の中で折り返すため、採番と同じ値を止める側でも
# 使う。3列目が無いリポジトリでは空になり、原則の幅（1000）に落ちる。
DEV_PORT_WIDTH="$(local_repo_port_width "$TARGET_REPO" || true)"

# --- マージ先のブランチ -------------------------------------------------------
# リポジトリによって develop / main が混在する（#2123）。実在するものを全部拾い、
# **どれか1つにでも入っていれば「失われるものは無い」**とする。
BASE_REFS=()
while IFS= read -r ref; do
  [[ -n "$ref" ]] || continue
  BASE_REFS+=("$ref")
done < <(worktree_base_refs "$REPO_ROOT" || true)

base_refs_label() {
  if [[ ${#BASE_REFS[@]} -eq 0 ]]; then
    printf '%s' "マージ先"
    return 0
  fi
  local IFS='・'
  printf '%s' "${BASE_REFS[*]}"
}

# 「最新化し直してください」の案内に載せるブランチ名。基準refが1つも無いときは`develop`を出す
# （そのcloneではまだ何もfetchできていないので、まずは既定のブランチを取りに行かせる）。
base_fetch_hint_branch() {
  if [[ ${#BASE_REFS[@]} -eq 0 ]]; then
    printf 'develop'
    return 0
  fi
  printf '%s' "${BASE_REFS[0]#origin/}"
}

if [[ ${#BASE_REFS[@]} -eq 0 ]]; then
  echo "警告: $TARGET_REPO にマージ先のブランチ（origin/develop・origin/main）が見つかりません。判定できないworktreeはすべて残します。" >&2
fi

if [[ "$DO_FETCH" -eq 1 && ${#BASE_REFS[@]} -gt 0 ]]; then
  fetch_branches=()
  for ref in "${BASE_REFS[@]}"; do
    fetch_branches+=("${ref#origin/}")
  done
  echo "$TARGET_REPO の ${fetch_branches[*]} を最新化しています..."
  # **fetchの失敗でスクリプトを落とさない**（#2123）。古いままでも判定は「入っていない」＝
  # 残す側（安全側）へ倒れる。全リポジトリを回すときに1本の通信断で残りが止まる方が困る。
  fetch_cmd=(git -C "$REPO_ROOT" fetch origin "${fetch_branches[@]}")
  if command -v timeout >/dev/null 2>&1; then
    fetch_cmd=(timeout "${ISSUE_DECK_CLEANUP_FETCH_TIMEOUT:-60}" "${fetch_cmd[@]}")
  fi
  if ! "${fetch_cmd[@]}"; then
    echo "警告: $TARGET_REPO の最新化に失敗しました。判定は古い情報のまま（残す側）で続けます。" >&2
  fi
fi

# 実行中のカレントディレクトリと、このスクリプトが置かれているチェックアウトは削除しない。
# 自分の足元を消すと git の内部状態も巻き込むため。
CURRENT_DIR="$(pwd -P)"

# 走査の進捗表示（#1680）。worktreeが100件を超えると走査に数十秒かかるのに、以前は結果が
# 出るまで1行も出さなかったため、`--dry-run`が「終わらない」ようにしか見えなかった。
# 端末では同じ行を上書きし、ファイルへリダイレクトされているときは一定件数ごとに1行だけ出す。
PROGRESS_EVERY=25

progress_update() {
  local done_count="$1" total="$2" label="$3"
  if [[ -t 2 ]]; then
    printf '\r\033[K走査中 %d/%d %s' "$done_count" "$total" "$label" >&2
  elif (( done_count % PROGRESS_EVERY == 0 || done_count == total )); then
    printf '走査中 %d/%d\n' "$done_count" "$total" >&2
  fi
}

progress_clear() {
  if [[ -t 2 ]]; then
    printf '\r\033[K' >&2
  fi
}

# マージ済みPRの番号は削除理由の表示にだけ使う（#1192）。worktreeごとに `gh` を呼ぶと
# 1件あたり0.5秒前後のAPI往復が件数ぶん積み上がり、170件で1分半を超える（#1680）。
# 1回の呼び出しでまとめて引いて引き当てる。--issue で1件に絞っているときは、全件を引く方が
# 高くつくのでその1件だけ引く。
declare -A merged_pr_by_branch=()

merged_pr_for() {
  local n="$1"
  if [[ -n "$TARGET_ISSUE" ]]; then
    worktree_merged_pr "$n" "$TARGET_REPO"
  else
    echo "${merged_pr_by_branch[issue-$n]:-}"
  fi
}

# 削除対象のサイズをまとめて測る（#1680）。worktreeは1件あたり1GB・十数万ファイルあり、`du`は
# 1件0.2〜0.3秒かかる。100件を超えると走査そのものより高くつくうえ、下に書いたとおり数値自体が
# 共有分を含んで当てにならないため、既定では測らず `--size` を付けたときだけ測る。
# 並列にしても3割ほどしか縮まない（ディスクのメタデータ読み出しで詰まる）。
measure_sizes() {
  printf '%s\0' "$@" | xargs -0 -r -P 8 -n 1 du -sh 2>/dev/null
}

# 判定結果。表示は「削除対象 → 残す」の順にまとめるため、いったん配列へ貯める。
target_dirs=()
target_numbers=()
target_notes=()
# 対象ごとの強制削除フラグ。`git worktree remove` に `--force` を付けるかどうかに使う。
target_forced=()
# 残すworktreeは理由（notes）と、消したいときの対処（hints）を対で持つ（#1192）。理由だけだと
# 「じゃあどうすれば消えるのか」が分からず、結局 git worktree remove を手で打つことになる。
keep_notes=()
keep_hints=()
# 残すworktreeのうち、`.next`（ビルド成果物）を消してよいもの（#1716）。
prune_next_dirs=()
prune_next_numbers=()

keep_worktree() {
  keep_notes+=("$1")
  keep_hints+=("$2")
}

# 残すと決めたworktreeの `.next` を削除候補に積む（#1716）。
#
# **呼ぶのは「セッションも開発サーバーも動いておらず、起動の準備からも十分に経っている」と
# 判定した後だけ。** 動いている最中に消すとビルドが壊れ、準備中に消すと初回の起動を遅らせる。
mark_next_for_prune() {
  local n="$1" dir="$2"
  [[ "$PRUNE_NEXT" -eq 1 ]] || return 0
  [[ -d "$dir/.next" ]] || return 0
  prune_next_dirs+=("$dir/.next")
  prune_next_numbers+=("$n")
}

# 自分自身を指す案内文の先頭部分。**対象リポジトリが既定でなければ `--repo` を付ける**
# （#2123。付けずに案内すると、コピペした人はissue-deckを掃除しに行くことになる）。
self_command() {
  if [[ "$TARGET_REPO" == "$DEFAULT_REPO" ]]; then
    printf 'bash %s' "$SELF"
  else
    printf 'bash %s --repo %s' "$SELF" "$TARGET_REPO"
  fi
}

# --force の案内文。コピペでそのまま実行できるよう絶対パスで出す。
force_hint() {
  echo "残す必要が無ければ: $(self_command) --issue $1 --force"
}

# 動いているセッションの止め方の案内。tmuxのセッション名は起動側（scripts/start-issue.sh の
# tmux_session_name）が `<リポジトリ名>-issue-<番号>` の形で付けるが、名前を組み立て直すと
# 起動側の変更に追随できないため、実際に動いているセッション名をtmuxから引く。
# セッション名は`<リポジトリ名>-issue-<番号>`なので、**対象リポジトリのものだけを引く**
# （#2123。番号だけで引くと、別リポジトリの同じ番号のセッションを止めるよう案内してしまう）。
session_stop_hint() {
  local n="$1" name
  name="$(tmux ls -F '#S' 2>/dev/null | grep -Fx -- "$SAFE_REPO-issue-$n" | head -n 1 || true)"
  if [[ -n "$name" ]]; then
    echo "先にセッションを終える: tmux kill-session -t $name"
  else
    echo "開発サーバーだけが残っている: bash $ROOT/scripts/reap-dev-servers.sh で回収してから再実行する"
  fi
}

# 先に対象のworktreeだけを集める。全体の件数が分からないと進捗を「N/M」で出せないため、
# 判定と同じループで読み進めない（#1680）。
managed_dirs=()
while IFS= read -r line; do
  [[ "$line" == worktree\ * ]] || continue
  dir="${line#worktree }"

  # 管理対象は $WORKTREE_BASE/issue-<番号> だけ。本体チェックアウトや手作りのworktreeは触らない。
  case "$dir" in
    "$WORKTREE_BASE"/issue-*) ;;
    *) continue ;;
  esac
  n="${dir#"$WORKTREE_BASE"/issue-}"
  [[ "$n" =~ ^[0-9]+$ ]] || continue
  if [[ -n "$TARGET_ISSUE" && "$n" != "$TARGET_ISSUE" ]]; then
    continue
  fi
  managed_dirs+=("$dir")
done < <(git -C "$REPO_ROOT" worktree list --porcelain)

scan_total="${#managed_dirs[@]}"

# 対象が無いときはAPIを叩かない。--issue で1件に絞っているときは merged_pr_for が1件だけ引く。
if [[ -z "$TARGET_ISSUE" && "$scan_total" -gt 0 ]]; then
  echo "マージ済みPRの一覧を取得しています..."
  while IFS=$'\t' read -r branch pr; do
    [[ -n "$branch" ]] || continue
    merged_pr_by_branch["$branch"]="$pr"
  done < <(worktree_merged_pr_map "$TARGET_REPO")
fi

for scan_index in "${!managed_dirs[@]}"; do
  dir="${managed_dirs[$scan_index]}"
  n="${dir#"$WORKTREE_BASE"/issue-}"
  progress_update "$((scan_index + 1))" "$scan_total" "#$n"

  # ここから下の3つ（実行中のworktree・壊れている・別ブランチ）と、その次のセッション稼働中は
  # **--force でも消さない**。消して失われるのではなく、消すと壊れる・他の作業を巻き込むため。
  if [[ "$CURRENT_DIR" == "$dir" || "$CURRENT_DIR" == "$dir"/* || "$ROOT" == "$dir" ]]; then
    # スクリプト自身がこのworktreeの中にある場合は、cwdを動かしても対象から外れない。
    # 本体チェックアウト側の同じスクリプトから実行してもらう。
    if [[ "$ROOT" == "$dir" ]]; then
      keep_worktree "#$n このスクリプト自身が置かれているworktree" \
        "本体チェックアウトの scripts/cleanup-worktrees.sh --issue $n から実行する"
    else
      keep_worktree "#$n このスクリプトを実行しているworktree（カレントディレクトリ）" \
        "別のディレクトリ（例: cd ~）へ移動してから実行する"
    fi
    continue
  fi

  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    keep_worktree "#$n gitの作業ツリーとして壊れている" \
      "中身を確認して手動で削除する: rm -rf $dir && git -C $REPO_ROOT worktree prune && git -C $REPO_ROOT branch -D issue-$n"
    continue
  fi

  branch="$(git -C "$dir" branch --show-current)"
  if [[ "$branch" != "issue-$n" ]]; then
    keep_worktree "#$n 別ブランチを開いている（${branch:-デタッチHEAD}）" \
      "issue-$n へ戻す（git -C $dir switch issue-$n）か、中身を確認して手動で削除する"
    continue
  fi

  if worktree_session_running "$n" "$WORKTREE_BASE"; then
    keep_worktree "#$n セッションまたは開発サーバーが動いている" "$(session_stop_hint "$n")"
    continue
  fi

  # 起動の準備中に当たらないようにする（#1716）。ここから下の判定はどれも「いま何かが
  # 動いているか」を見ておらず、worktreeを作ってからセッションのプロセスが立つまでの数分間は
  # 削除対象の条件をすべて満たしてしまう。**判定できない（空）ときも消さない側へ倒す。**
  if [[ "$MIN_AGE_MINUTES" -gt 0 ]]; then
    prepared_minutes="$(worktree_prepared_minutes "$dir" "$PROMPT_DIR/issue-$n.md")"
    if [[ -z "$prepared_minutes" ]]; then
      keep_worktree "#$n 起動の準備からの経過時間を判定できない" \
        "対象だと分かっているなら: $(self_command) --issue $n"
      continue
    fi
    if [[ "$prepared_minutes" -lt "$MIN_AGE_MINUTES" ]]; then
      keep_worktree "#$n 起動の準備から ${prepared_minutes}分（最小 ${MIN_AGE_MINUTES}分）しか経っていない" \
        "今すぐ消すなら: $(self_command) --issue $n"
      continue
    fi
  fi

  dirty_count="$(worktree_dirty_count "$dir")"
  # 空文字は「判定できなかった」。0（＝失われるコミットが無い）と区別する（#1192）。
  unpushed="$(worktree_commits_not_in_base "$REPO_ROOT" "issue-$n" ${BASE_REFS[@]+"${BASE_REFS[@]}"})"

  # --force は --issue で1件に絞ったときだけ来る。何が失われるかを表示に載せてから消す。
  if [[ "$FORCE" -eq 1 ]]; then
    loss_text=""
    if [[ "$dirty_count" -gt 0 ]]; then
      loss_text="未コミットの変更 $dirty_count 件"
    fi
    if [[ -z "$unpushed" ]]; then
      loss_text="${loss_text:+$loss_text、}$(base_refs_label) との差分は判定不能"
    elif [[ "$unpushed" -gt 0 ]]; then
      loss_text="${loss_text:+$loss_text、}$(base_refs_label) に入っていないコミット $unpushed 件"
    fi
    loss_text="失われるもの: ${loss_text:-なし}"
    target_dirs+=("$dir")
    target_numbers+=("$n")
    target_forced+=(1)
    target_notes+=("--force 指定 / $loss_text")
    continue
  fi

  # ここから下の「残す」3つは、**セッションも開発サーバーも動いておらず、起動の準備からも
  # 十分に経っている**worktree（#1716）。worktree自体は残すが、`.next`は作り直せるので消す。
  if [[ "$dirty_count" -gt 0 ]]; then
    keep_worktree "#$n 未コミットの変更が $dirty_count 件ある" "$(force_hint "$n")"
    mark_next_for_prune "$n" "$dir"
    continue
  fi

  if [[ -z "$unpushed" ]]; then
    keep_worktree "#$n マージ先との差分を判定できない（fetchに失敗している可能性）" \
      "git -C $REPO_ROOT fetch origin $(base_fetch_hint_branch) を通してから再実行する"
    mark_next_for_prune "$n" "$dir"
    continue
  fi

  if [[ "$unpushed" -gt 0 ]]; then
    keep_worktree "#$n $(base_refs_label) に入っていないコミットが $unpushed 件ある（未pushの作業）" \
      "$(force_hint "$n")"
    mark_next_for_prune "$n" "$dir"
    continue
  fi

  # ここまで来たら消して失われるものは無い。マージ済みPRの有無は理由の表示にだけ使う（#1192）。
  merged_pr="$(merged_pr_for "$n")"
  if [[ -n "$merged_pr" ]]; then
    reason="PR #$merged_pr マージ済み"
  else
    # gh が不通ならマージ済みでもここへ来るため、「作業実績が無い」とは言い切らない。
    reason="$(base_refs_label) に未反映のコミットが0件（消しても失われるものが無い）"
  fi

  target_dirs+=("$dir")
  target_numbers+=("$n")
  target_forced+=(0)
  target_notes+=("$reason")
done
progress_clear

# サイズは `--size` のときだけ、削除対象のぶんを走査後にまとめて測る（#1680）。
target_sizes=()
if [[ "$SHOW_SIZE" -eq 1 && ${#target_dirs[@]} -gt 0 ]]; then
  echo "削除対象のサイズを集計しています（${#target_dirs[@]}件）..."
  declare -A size_by_dir=()
  while IFS=$'\t' read -r size path; do
    [[ -n "$path" ]] || continue
    size_by_dir["$path"]="$size"
  done < <(measure_sizes "${target_dirs[@]}")
  for dir in "${target_dirs[@]}"; do
    target_sizes+=("${size_by_dir[$dir]:-不明}")
  done
fi

echo ""
echo "=== 削除対象 (${#target_dirs[@]}件) ==="
if [[ ${#target_dirs[@]} -eq 0 ]]; then
  echo "  (なし)"
else
  for i in "${!target_dirs[@]}"; do
    if [[ "$SHOW_SIZE" -eq 1 ]]; then
      printf '  #%s  %s / %s\n' "${target_numbers[$i]}" "${target_notes[$i]}" "${target_sizes[$i]}"
    else
      printf '  #%s  %s\n' "${target_numbers[$i]}" "${target_notes[$i]}"
    fi
  done
  if [[ "$SHOW_SIZE" -eq 1 ]]; then
    # pnpmはnode_modulesの実体をストアへのハードリンクとして持つため、worktreeごとのduは
    # 他のworktreeと共有している分まで数える。実際に解放されるのはこの合計よりかなり小さい。
    echo "  ※サイズはpnpmストアとのハードリンク共有分を含むため、実際に解放される容量はこれより小さい"
  else
    echo "  ※ディスク使用量を出すには --size を付ける（1件あたり0.2秒ほどかかるため既定では測らない）"
  fi
fi

echo ""
echo "=== 残すworktree (${#keep_notes[@]}件) ==="
if [[ ${#keep_notes[@]} -eq 0 ]]; then
  echo "  (なし)"
else
  # 理由の下に「どうすれば消せるか」を出す（#1192）。理由だけを出していた頃は、消したい
  # worktreeがあっても git worktree remove を手で打つしかなかった。
  for i in "${!keep_notes[@]}"; do
    echo "  ${keep_notes[$i]}"
    if [[ -n "${keep_hints[$i]}" ]]; then
      echo "        → ${keep_hints[$i]}"
    fi
  done
fi
echo ""

# 残すworktreeの `.next`（#1716）。**worktreeを消さない側の解放手段**で、削除対象が0件でも
# ここだけは効く。サイズは削除対象と同じく `--size` のときだけ測る。
next_sizes=()
if [[ ${#prune_next_dirs[@]} -gt 0 ]]; then
  if [[ "$SHOW_SIZE" -eq 1 ]]; then
    echo "残すworktreeの .next のサイズを集計しています（${#prune_next_dirs[@]}件）..."
    declare -A next_size_by_dir=()
    while IFS=$'\t' read -r size path; do
      [[ -n "$path" ]] || continue
      next_size_by_dir["$path"]="$size"
    done < <(measure_sizes "${prune_next_dirs[@]}")
    for dir in "${prune_next_dirs[@]}"; do
      next_sizes+=("${next_size_by_dir[$dir]:-不明}")
    done
  fi
  echo "=== 残すworktreeで削除する .next (${#prune_next_dirs[@]}件) ==="
  for i in "${!prune_next_dirs[@]}"; do
    if [[ "$SHOW_SIZE" -eq 1 ]]; then
      printf '  #%s  %s / %s\n' "${prune_next_numbers[$i]}" "${prune_next_dirs[$i]}" "${next_sizes[$i]}"
    else
      printf '  #%s  %s\n' "${prune_next_numbers[$i]}" "${prune_next_dirs[$i]}"
    fi
  done
  echo "  ※ビルド成果物なので、次に pnpm dev / pnpm build を打てば作り直される（残すには --keep-next）"
  echo ""
fi

if [[ ${#target_dirs[@]} -eq 0 && ${#prune_next_dirs[@]} -eq 0 ]]; then
  # --force は1件に絞って指定するものなので、その1件が見つからなかったなら打ち間違いを疑う。
  if [[ "$FORCE" -eq 1 && ${#keep_notes[@]} -eq 0 ]]; then
    echo "Error: worktree $WORKTREE_BASE/issue-$TARGET_ISSUE が見つかりません。" >&2
    exit 1
  fi
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "--dry-run のため削除しません。"
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "非対話実行のため削除しません。削除する場合は --yes を付けて実行してください。"
    exit 0
  fi
  prompt="上記 ${#target_dirs[@]} 件のworktree・ブランチと ${#prune_next_dirs[@]} 件の .next を削除しますか？ [y/N]: "
  if [[ "$FORCE" -eq 1 ]]; then
    prompt="上記を --force で削除します。「失われるもの」は取り戻せません。続けますか？ [y/N]: "
  fi
  read -r -p "$prompt" answer
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "中止しました。"; exit 0 ;;
  esac
fi

failed=0
# **添字の展開は空配列でも安全な形で書く。** `${!arr[@]}` は空配列でも空に展開されるが、
# `${!arr[@]+...}` と書くと `${!name}`（間接参照）として解釈され `invalid variable name` で落ちる。
for ((i = 0; i < ${#target_dirs[@]}; i++)); do
  dir="${target_dirs[$i]}"
  n="${target_numbers[$i]}"
  echo "#$n: worktreeを削除しています（$dir）..."
  # **消す前に開発サーバーを止める**（#1524）。ここへ来るのは「セッションも開発サーバーも
  # 動いていない」と判定されたworktreeだが、その判定はPIDファイルと`run-issue-session.sh`の
  # プロセスしか見ていない。実装エージェントが手で起こし直した`pnpm dev`はどちらにも載らず、
  # worktreeを消してもcwdを失ったまま走り続ける（#1523の孤児）。ポートから引けば起動経路に
  # よらず止まる。
  # ポート帯が引けないリポジトリでは**止めに行かない**（#2123）。既定値へ落ちると、他リポジトリの
  # 掃除でissue-deckのポートを撃ちに行くことになる。
  dev_port=""
  if [[ -n "$DEV_PORT_BASE" || "$TARGET_REPO" == "$DEFAULT_REPO" ]]; then
    dev_port="$(dev_server_port_for_issue "$n" ${DEV_PORT_BASE:+"$DEV_PORT_BASE"} ${DEV_PORT_WIDTH:+"$DEV_PORT_WIDTH"} || true)"
  fi
  if [[ -n "$dev_port" ]]; then
    dev_server_stop_by_port "$dev_port" "$dir" "$DEV_SERVER_DIR/issue-$n.log" "worktreeの削除" ||
      echo "警告: #$n: ポート $dev_port を掴んでいた開発サーバーを停止できませんでした。" >&2
  fi
  # `git worktree remove` は未コミットの変更があると失敗する。--force を指定した対象だけ
  # そこを越える（#1192）。通常の対象には付けない。判定を1つ取りこぼしたときに、そのまま
  # 消してしまうのを止める最後の砦になっている。
  remove_args=()
  if [[ "${target_forced[$i]}" -eq 1 ]]; then
    remove_args+=(--force)
  fi
  if ! git -C "$REPO_ROOT" worktree remove "${remove_args[@]}" "$dir"; then
    echo "警告: #$n のworktree削除に失敗しました。ブランチはそのまま残します。" >&2
    failed=$((failed + 1))
    continue
  fi
  # コミットがすべて origin/develop に入っていることを確認済みなので -D でよい。-d は
  # 「現在のHEADにマージ済みか」を見るため、本体チェックアウトが別のIssueブランチを
  # 開いていると消せない。--force の対象は develop に入っていないコミットごと消すため、
  # ここは -D でなければ消せない。
  if ! git -C "$REPO_ROOT" branch -D "issue-$n" >/dev/null; then
    echo "警告: #$n のブランチ削除に失敗しました。" >&2
    failed=$((failed + 1))
  fi
  rm -f "$PROMPT_DIR/issue-$n.md" "$DEV_SERVER_DIR/issue-$n.log" "$DEV_SERVER_DIR/issue-$n.pid"
done

git -C "$REPO_ROOT" worktree prune

# 残すworktreeの `.next` を消す（#1716）。**worktreeの削除より後に行う**。消えるworktreeの
# `.next` は削除で一緒に消えるため、ここへ積むのは残す側だけ。
for ((i = 0; i < ${#prune_next_dirs[@]}; i++)); do
  next_dir="${prune_next_dirs[$i]}"
  n="${prune_next_numbers[$i]}"
  echo "#$n: .next を削除しています（$next_dir）..."
  if ! rm -rf "$next_dir"; then
    echo "警告: #$n の .next 削除に失敗しました。" >&2
    failed=$((failed + 1))
  fi
done

if [[ "$failed" -gt 0 ]]; then
  echo "$failed 件の削除に失敗しました。" >&2
  exit 1
fi

echo "削除が完了しました。"
