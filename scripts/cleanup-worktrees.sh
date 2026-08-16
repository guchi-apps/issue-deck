#!/usr/bin/env bash
# マージ済みIssueのworktree・ブランチを掃除する（#1100）
#
# 使い方:
#   scripts/cleanup-worktrees.sh [--dry-run] [--yes] [--issue <番号>] [--no-fetch] [--force] [--size]
#
#   --dry-run       判定結果を表示するだけで削除しない
#   --yes / -y      確認プロンプトを出さずに削除する
#   --issue <番号>  対象を1つのIssueに絞る
#   --no-fetch      origin/develop の最新化（git fetch）を行わない
#   --force         未コミットの変更・未pushのコミットを無視して削除する（--issue 必須）
#   --size          削除対象のディスク使用量を測って表示する（既定では測らない）
#
# 次をすべて満たすworktreeだけを削除対象にする。1つでも欠けたら残す。
#   - 未コミットの変更が無い
#   - origin/develop に入っていないコミットが無い（未pushの作業が無い）
#   - そのIssueのセッション・開発サーバーが動いていない
#   - ブランチ issue-<番号> を開いていて、gitの作業ツリーとして壊れていない
#   - このスクリプトを実行しているworktreeでない
#
# **「PRがマージ済みか」は判定に使わない**（#1192）。消して失われるものが無いことは上の2つで
# 決まり、PRの有無はそこへ何も足さない（developに入っていないコミットが1つでもあれば必ず残る）。
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
# **worktreeが100件を超えても数十秒で終わること**を前提に書く（#1680）。1件ずつ `gh` を叩き、
# 1件ずつ `du` でサイズを測っていた頃は170件で4分以上かかり、その間1行も出力しないため
# `--dry-run` が固まったようにしか見えなかった。worktreeの数に比例して増える処理を足すときは、
# まとめて1回で引けないか・進捗を出せるかを先に考える。
#
# 環境変数:
#   ISSUE_DECK_WORKTREE_BASE  worktreeの置き場所（既定: ~/apps/issue-deck-worktrees）
#   ISSUE_DECK_GH_TIMEOUT     gh の1回の呼び出しに被せる制限時間・秒（既定: 60）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
PROMPT_DIR="$WORKTREE_BASE/.prompts"
DEV_SERVER_DIR="$WORKTREE_BASE/.dev-servers"

# shellcheck source=scripts/lib/worktree-status.sh
source "$ROOT/scripts/lib/worktree-status.sh"
# worktreeを消す前に開発サーバーを止める（#1524）。止め方は run-issue-session.sh・
# reap-dev-servers.sh と共有する。
# shellcheck source=scripts/lib/dev-server.sh
source "$ROOT/scripts/lib/dev-server.sh"

usage() {
  echo "Usage: scripts/cleanup-worktrees.sh [--dry-run] [--yes] [--issue <番号>] [--no-fetch] [--force] [--size]"
}

DRY_RUN=0
ASSUME_YES=0
DO_FETCH=1
FORCE=0
SHOW_SIZE=0
TARGET_ISSUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-fetch) DO_FETCH=0 ;;
    --force) FORCE=1 ;;
    --size) SHOW_SIZE=1 ;;
    --issue) shift; TARGET_ISSUE="${1:-}" ;;
    --issue=*) TARGET_ISSUE="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Error: 不明な引数です: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ -n "$TARGET_ISSUE" && ! "$TARGET_ISSUE" =~ ^[0-9]+$ ]]; then
  echo "Error: --issue は数字で指定してください: $TARGET_ISSUE" >&2
  exit 1
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

if [[ "$DO_FETCH" -eq 1 ]]; then
  echo "origin/develop を最新化しています..."
  git -C "$ROOT" fetch origin develop
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
    worktree_merged_pr "$n"
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

keep_worktree() {
  keep_notes+=("$1")
  keep_hints+=("$2")
}

# --force の案内文。コピペでそのまま実行できるよう絶対パスで出す。
force_hint() {
  echo "残す必要が無ければ: bash $ROOT/scripts/cleanup-worktrees.sh --issue $1 --force"
}

# 動いているセッションの止め方の案内。tmuxのセッション名は起動側（scripts/start-issue.sh の
# tmux_session_name）が `<リポジトリ名>-issue-<番号>` の形で付けるが、名前を組み立て直すと
# 起動側の変更に追随できないため、実際に動いているセッション名をtmuxから引く。
session_stop_hint() {
  local n="$1" name
  name="$(tmux ls -F '#S' 2>/dev/null | grep -E -- "-issue-$n\$" | head -n 1 || true)"
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
done < <(git -C "$ROOT" worktree list --porcelain)

scan_total="${#managed_dirs[@]}"

# 対象が無いときはAPIを叩かない。--issue で1件に絞っているときは merged_pr_for が1件だけ引く。
if [[ -z "$TARGET_ISSUE" && "$scan_total" -gt 0 ]]; then
  echo "マージ済みPRの一覧を取得しています..."
  while IFS=$'\t' read -r branch pr; do
    [[ -n "$branch" ]] || continue
    merged_pr_by_branch["$branch"]="$pr"
  done < <(worktree_merged_pr_map)
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
      "中身を確認して手動で削除する: rm -rf $dir && git -C $ROOT worktree prune && git -C $ROOT branch -D issue-$n"
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

  dirty_count="$(worktree_dirty_count "$dir")"
  # 空文字は「判定できなかった」。0（＝失われるコミットが無い）と区別する（#1192）。
  unpushed="$(worktree_commits_not_in_develop "$ROOT" "issue-$n")"

  # --force は --issue で1件に絞ったときだけ来る。何が失われるかを表示に載せてから消す。
  if [[ "$FORCE" -eq 1 ]]; then
    loss_text=""
    if [[ "$dirty_count" -gt 0 ]]; then
      loss_text="未コミットの変更 $dirty_count 件"
    fi
    if [[ -z "$unpushed" ]]; then
      loss_text="${loss_text:+$loss_text、}origin/develop との差分は判定不能"
    elif [[ "$unpushed" -gt 0 ]]; then
      loss_text="${loss_text:+$loss_text、}origin/develop に入っていないコミット $unpushed 件"
    fi
    loss_text="失われるもの: ${loss_text:-なし}"
    target_dirs+=("$dir")
    target_numbers+=("$n")
    target_forced+=(1)
    target_notes+=("--force 指定 / $loss_text")
    continue
  fi

  if [[ "$dirty_count" -gt 0 ]]; then
    keep_worktree "#$n 未コミットの変更が $dirty_count 件ある" "$(force_hint "$n")"
    continue
  fi

  if [[ -z "$unpushed" ]]; then
    keep_worktree "#$n origin/develop との差分を判定できない（fetchに失敗している可能性）" \
      "git -C $ROOT fetch origin develop を通してから再実行する"
    continue
  fi

  if [[ "$unpushed" -gt 0 ]]; then
    keep_worktree "#$n origin/develop に入っていないコミットが $unpushed 件ある（未pushの作業）" \
      "$(force_hint "$n")"
    continue
  fi

  # ここまで来たら消して失われるものは無い。マージ済みPRの有無は理由の表示にだけ使う（#1192）。
  merged_pr="$(merged_pr_for "$n")"
  if [[ -n "$merged_pr" ]]; then
    reason="PR #$merged_pr マージ済み"
  else
    # gh が不通ならマージ済みでもここへ来るため、「作業実績が無い」とは言い切らない。
    reason="developに未反映のコミットが0件（消しても失われるものが無い）"
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

if [[ ${#target_dirs[@]} -eq 0 ]]; then
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
  prompt="上記 ${#target_dirs[@]} 件のworktree・ブランチを削除しますか？ [y/N]: "
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
for i in "${!target_dirs[@]}"; do
  dir="${target_dirs[$i]}"
  n="${target_numbers[$i]}"
  echo "#$n: worktreeを削除しています（$dir）..."
  # **消す前に開発サーバーを止める**（#1524）。ここへ来るのは「セッションも開発サーバーも
  # 動いていない」と判定されたworktreeだが、その判定はPIDファイルと`run-issue-session.sh`の
  # プロセスしか見ていない。実装エージェントが手で起こし直した`pnpm dev`はどちらにも載らず、
  # worktreeを消してもcwdを失ったまま走り続ける（#1523の孤児）。ポートから引けば起動経路に
  # よらず止まる。
  dev_port="$(dev_server_port_for_issue "$n" || true)"
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
  if ! git -C "$ROOT" worktree remove "${remove_args[@]}" "$dir"; then
    echo "警告: #$n のworktree削除に失敗しました。ブランチはそのまま残します。" >&2
    failed=$((failed + 1))
    continue
  fi
  # コミットがすべて origin/develop に入っていることを確認済みなので -D でよい。-d は
  # 「現在のHEADにマージ済みか」を見るため、本体チェックアウトが別のIssueブランチを
  # 開いていると消せない。--force の対象は develop に入っていないコミットごと消すため、
  # ここは -D でなければ消せない。
  if ! git -C "$ROOT" branch -D "issue-$n" >/dev/null; then
    echo "警告: #$n のブランチ削除に失敗しました。" >&2
    failed=$((failed + 1))
  fi
  rm -f "$PROMPT_DIR/issue-$n.md" "$DEV_SERVER_DIR/issue-$n.log" "$DEV_SERVER_DIR/issue-$n.pid"
done

git -C "$ROOT" worktree prune

if [[ "$failed" -gt 0 ]]; then
  echo "$failed 件の削除に失敗しました。" >&2
  exit 1
fi

echo "削除が完了しました。"
