#!/usr/bin/env bash
# 本体リポジトリの作業ツリーにある `scripts/` が `origin/develop` と違っていたら警告し（#1274）、
# **セッション側のスクリプトだけは `origin/develop` の同期コピーから走らせる**（#1438）。
#
# scripts/start-issue.sh・scripts/generic-start-issue.sh・scripts/run-issue-session.sh の
# いずれからも source する。このファイル自体は実行せず、source して使う。
#
# **`warn_launcher_scripts_stale` の呼び出し自体は start-issue.sh・generic-start-issue.sh と
# run-issue-session.sh の両方に置く（#1426）。** start-issue.sh 側の呼び出しは、tmuxで新しい
# セッションを起動する（`tmux new-session -d`）より前の、呼び出し元プロセス自身の標準出力に
# 出るだけで、そのpaneは呼び出し元とは別のptyとして作られるため引き継がれない。サブPCのpollerが
# 起動する経路（無人）ではその標準出力はjournalctlにしか残らず、tmuxをattachしたユーザーからは
# 見えない。run-issue-session.sh側の呼び出しは実際にそのtmuxのpaneの中で動くため、ここでも
# 同じ警告を出すことで、ユーザーが実際に見る画面に確実に載せる。
#
# ## なぜ必要か
#
# 起動スクリプトもフックも、**worktreeではなく本体リポジトリの作業ツリーから実行される**。
#
#   scripts/start-issue.sh          → 本体の作業ツリー（$ROOT/scripts/）
#   scripts/run-issue-session.sh    → 同上（start-issue.sh が $ROOT/scripts/ を指定して呼ぶ）
#   scripts/session-notify.sh       → 同上（run-issue-session.sh が生成するフック設定の command）
#
# 一方で worktree は `git fetch origin develop` した直後の `origin/develop` から作られる。
# **本体の作業ツリーだけは誰も更新しない**（start-issue.sh は「本体の作業ツリーには一切
# 触れない」ことを約束しているため、fetchはしてもmergeはしない）。
#
# 結果として「developには修正が入っているのに、実際に動いているスクリプトは古いまま」が
# 起こる。#1274ではこれを踏んだ。#1247でセッション通知のリンク書式を直しdevelopへマージ
# したあとも、本体の作業ツリーが数時間前のdevelopのままだったため、実際に飛ぶ通知は
# 古い書式（リンクにならない生URL）のままだった。**スクリプト側には何の兆候も出ない**ので、
# 直したはずの不具合を再度Issueとして起票することになる。
#
# ## 止めないこと・作業ツリーに触れないこと
#
# 判定はあくまで警告で、**起動は止めない**。ネットワークが無い場所・gitのリモートが無い
# 環境でも黙って素通りする。
#
# **ここでpullはしない。** 本体の作業ツリーに触れないのは start-issue.sh の設計上の約束で、
# 未コミットの変更やチェックアウト中のブランチを起動スクリプトが動かしてよいことにすると、
# 「セッションを起こしただけ」の操作が手元の作業を壊しうる。取り込むかどうかは人が決める。
#
# ## 警告だけでは足りなかった（#1438）
#
# #1274・#1426の警告は「気づける」ようにしただけで、pullするまで**古いフックが動き続ける**
# ことは変わらない。実際に、`00.check-user`を計画の承認と同時に外す仕組み（#1357・#1417）を
# developへ入れた後も、本体の作業ツリーが古いホストでは`PostToolUse`のフック設定そのものが
# 生成されず（フック設定を書くのは`run-issue-session.sh`）、承認しても`00.check-user`が
# 応答終了（`Stop`）まで外れなかった。**セッションを起こした人からは、直したはずの機能が
# 動いていないようにしか見えない。**
#
# そこで、セッションと一緒に動くもの（`run-issue-session.sh`と、それが呼ぶ`lib/`・
# `session-notify.sh`、そしてセッションへそのまま渡るプロンプトのひな形`prompts/`）だけは、
# 本体の作業ツリーではなく`origin/develop`から取り出した同期コピー
# （`~/.cache/issue-deck/launcher-scripts/<SHA>/scripts/`）から読む。
# 作業ツリーには一切触れないまま、フックとプロンプトの中身だけを新しくできる。
#
# **同期コピーを使うのは「本体の作業ツリーが単に古いだけ」と確かめられたときに限る。**
# `scripts/`に未コミットの変更があるか、HEADが`origin/develop`に含まれていない（＝手元の
# ブランチにしか無い変更がある）場合は、これまでどおり作業ツリーのものを走らせる。
# 起動スクリプトが、人が今書いているものを黙って無かったことにしてはいけない。
#
# **これで新しくなるのはセッション側だけ。** 人が叩く入口（`start-issue.sh`・
# `generic-start-issue.sh`）とサブPCのpoller（systemdが起動する常駐プロセス）は引き続き
# 本体の作業ツリーから動くため、警告は残す。

# 比較対象。worktreeの作成元と同じ `origin/develop` を正とする。
LAUNCHER_SYNC_REF="${ISSUE_DECK_LAUNCHER_SYNC_REF:-origin/develop}"

# 同期コピーの置き場（#1438）。消えても作り直せる派生物なのでXDGのcacheに置く
# （状態ファイルの`~/.local/state/issue-deck/`とは性質が違う）。
launcher_scripts_cache_dir() {
  printf '%s' "${ISSUE_DECK_LAUNCHER_CACHE_DIR:-$HOME/.cache/issue-deck/launcher-scripts}"
}

# 比較・取り出しの前に `origin/develop` を引く。**プロセスにつき1回だけ**（警告と同期の
# 両方から呼ばれるため、同じfetchを2回走らせない）。
# ネットワークが不安定な場所で起動が待たされないよう上限を付ける（失敗しても続ける）。
launcher_scripts_fetch() {
  local root="${1:-}"
  [[ -n "$root" ]] || return 0
  [[ "${LAUNCHER_SCRIPTS_FETCHED:-0}" == "1" ]] && return 0
  LAUNCHER_SCRIPTS_FETCHED=1
  [[ "$LAUNCHER_SYNC_REF" == */* ]] || return 0

  local runner=()
  command -v timeout >/dev/null 2>&1 && runner=(timeout 15)
  local remote="${LAUNCHER_SYNC_REF%%/*}" branch="${LAUNCHER_SYNC_REF#*/}"
  ${runner[@]+"${runner[@]}"} git -C "$root" fetch "$remote" "$branch" >/dev/null 2>&1 || true
  return 0
}

# 本体の `scripts/` が `origin/develop` と違っていれば警告を出す。
# 戻り値は常に0（呼び出し側を `set -e` で落とさない）。
#
# 第1引数は本体リポジトリのパス（start-issue.sh・generic-start-issue.sh の $ROOT、
# run-issue-session.sh では自身の SCRIPT_DIR の親ディレクトリ）。
warn_launcher_scripts_stale() {
  [[ "${ISSUE_DECK_SKIP_SCRIPTS_SYNC_CHECK:-0}" == "1" ]] && return 0

  local root="${1:-}"
  [[ -n "$root" ]] || return 0
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  # 判定の前に fetch する。前回の起動時のfetchに頼ると、警告が必ず1回分遅れて出る。
  launcher_scripts_fetch "$root"

  # fetchできなかった・そのrefが無い環境では何も言わない。
  git -C "$root" rev-parse --verify --quiet "$LAUNCHER_SYNC_REF" >/dev/null 2>&1 || return 0

  # 作業ツリーと比較する（HEADではなく）。フックが実際に読むのは作業ツリーのファイルなので、
  # コミットされていない手元の変更も「developと違う」として出したほうが実態に合う。
  if git -C "$root" diff --quiet "$LAUNCHER_SYNC_REF" -- scripts/ 2>/dev/null; then
    return 0
  fi

  # 差分のあるファイルは件数が読めないので、先頭数件だけ出して残りは件数で示す。
  # 一覧そのものより「古い」ことに気づけるほうが大事なので、警告を長くしない。
  local all_changed changed total
  all_changed="$(git -C "$root" diff --name-only "$LAUNCHER_SYNC_REF" -- scripts/ 2>/dev/null)"
  total="$(printf '%s\n' "$all_changed" | grep -c . || true)"
  changed="$(printf '%s\n' "$all_changed" | head -5)"

  echo "" >&2
  echo "警告: 本体リポジトリの scripts/ が $LAUNCHER_SYNC_REF と違います（$root）。" >&2
  # 同期コピーを使えたかどうかで、警告が指す範囲が変わる（#1438）。**古いままの物が
  # 何なのかを言い切らないと、pullすべきかどうかを判断できない。**
  if [[ -n "${ISSUE_DECK_LAUNCHER_SCRIPTS_SHA:-${LAUNCHER_SCRIPTS_SHA:-}}" ]]; then
    echo "  セッション側（run-issue-session.sh・session-notify.sh・prompts/）は $LAUNCHER_SYNC_REF の" >&2
    echo "  同期コピーから読むため新しいままですが、この起動スクリプト自身とサブPCのpollerは" >&2
    echo "  本体の作業ツリーから動きます（#1438）。" >&2
  else
    echo "  起動スクリプトとセッション通知のフックは、worktreeではなく本体の作業ツリーから" >&2
    echo "  実行されます。developに入った修正は pull するまで反映されません（#1274）。" >&2
  fi
  if [[ -n "$changed" ]]; then
    local line
    while IFS= read -r line; do
      [[ -n "$line" ]] && echo "    - $line" >&2
    done <<<"$changed"
    if [[ "$total" -gt 5 ]]; then
      echo "    - ほか $((total - 5)) 件" >&2
    fi
  fi
  echo "  取り込む場合: git -C \"$root\" pull" >&2
  echo "  （起動は続けます。手元で意図的に変更している場合はこの警告で構いません）" >&2
  echo "" >&2
  return 0
}

# `origin/develop` の `scripts/` を同期コピーとして取り出す（#1438）。取り出せたら0を返す。
#
# **取り出し途中のディレクトリをフックに読ませない。** 一時ディレクトリへ展開してから
# ディレクトリごと置き換える（`mv`はrenameなので、同じファイルシステム上では中間状態が無い）。
# 同じSHAのコピーを別のセッションが同時に作っていた場合は、既にあるものをそのまま使う。
launcher_scripts_export() {
  local root="$1" sha="$2" dir="$3" tmp
  command -v tar >/dev/null 2>&1 || return 1
  [[ -d "$dir/scripts" ]] && return 0

  tmp="$dir.tmp.$$"
  rm -rf "$tmp" 2>/dev/null || true
  mkdir -p "$tmp" 2>/dev/null || return 1
  git -C "$root" archive --format=tar "$sha" scripts 2>/dev/null | tar -x -C "$tmp" 2>/dev/null || true
  # **パイプの終了コードには頼らない**（`pipefail`が無い呼び出し元では、gitが失敗しても
  # 空を受け取った`tar`が成功で返る）。取り出せたかどうかは結果を見て判断する
  if [[ ! -f "$tmp/scripts/run-issue-session.sh" ]]; then
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  if ! mv -T "$tmp" "$dir" 2>/dev/null; then
    rm -rf "$tmp" 2>/dev/null || true
    # 競合して負けた（相手が先に置いた）だけなら、それはそのまま使える
    [[ -d "$dir/scripts" ]] || return 1
  fi
  return 0
}

# 使われなくなった同期コピーを片付ける（#1438）。**使用中のものを消さないことが最優先。**
# 走っているセッションのフックは、そのコピーを何時間も読み続ける。現に使うコピーは
# 毎回 touch して新しくするため、30日触られていないディレクトリだけを消す。
launcher_scripts_prune() {
  local cache
  cache="$(launcher_scripts_cache_dir)"
  [[ -d "$cache" ]] || return 0
  find "$cache" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
  return 0
}

# セッション側のスクリプトをどこから走らせるかを決める（#1438）。
# 結果は次の2つのグローバル変数へ入れる（コマンド置換だとサブシェルになり、SHAを呼び出し元へ
# 返せないため、標準出力ではなく変数で返す）。
#
#   LAUNCHER_SCRIPTS_DIR   実際に走らせる scripts/ のパス（必ず入る）
#   LAUNCHER_SCRIPTS_SHA   同期コピーを使う場合のSHA。作業ツリーを使う場合は空
#
# 戻り値は常に0（呼び出し側を `set -e` で落とさない）。**判断に迷ったら作業ツリー**で、
# gitが無い・fetchできない・展開に失敗したといった場合はすべて従来どおりの動きに落ちる。
resolve_launcher_scripts_dir() {
  local root="${1:-}"
  LAUNCHER_SCRIPTS_DIR="$root/scripts"
  LAUNCHER_SCRIPTS_SHA=""

  [[ -n "$root" ]] || return 0
  # 警告を黙らせる指定（既存）と同じ変数で同期も止める。「手元のものをそのまま走らせたい」
  # という意図はどちらでも同じ
  [[ "${ISSUE_DECK_SKIP_SCRIPTS_SYNC_CHECK:-0}" == "1" ]] && return 0
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  # **判定より前に引く。** 前回の起動時のfetchに頼ると、同期が必ず1回分遅れる
  launcher_scripts_fetch "$root"
  git -C "$root" rev-parse --verify --quiet "$LAUNCHER_SYNC_REF" >/dev/null 2>&1 || return 0

  # 既に同じ内容なら同期コピーを作る意味が無い（＝pull済み・fetch直後のよくある状態）
  git -C "$root" diff --quiet "$LAUNCHER_SYNC_REF" -- scripts/ 2>/dev/null && return 0

  # **人が今書いているものを、起動スクリプトが黙って無かったことにしない。**
  # `scripts/`に未コミットの変更があれば、これまでどおり作業ツリーのものを走らせる
  git -C "$root" diff --quiet HEAD -- scripts/ 2>/dev/null || return 0
  # HEADが`origin/develop`に含まれていない＝手元のブランチにしか無い変更がある。
  # 「単に古いだけ」ではないので、こちらも作業ツリーを優先する
  git -C "$root" merge-base --is-ancestor HEAD "$LAUNCHER_SYNC_REF" >/dev/null 2>&1 || return 0

  local sha dir
  sha="$(git -C "$root" rev-parse "$LAUNCHER_SYNC_REF" 2>/dev/null || true)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 0
  dir="$(launcher_scripts_cache_dir)/$sha"

  launcher_scripts_export "$root" "$sha" "$dir" || return 0
  # 実行できる形で揃っていなければ使わない（半端なコピーでセッションを起こさない）
  [[ -x "$dir/scripts/run-issue-session.sh" && -x "$dir/scripts/session-notify.sh" ]] || return 0

  touch "$dir" 2>/dev/null || true
  LAUNCHER_SCRIPTS_DIR="$dir/scripts"
  LAUNCHER_SCRIPTS_SHA="$sha"
  launcher_scripts_prune
  return 0
}
