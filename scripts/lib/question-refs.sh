#!/usr/bin/env bash
# 横断質問セッション（#1454）が読むコードを`origin/develop`のスナップショットにする（#1583）。
#
# `scripts/start-cross-repo-question.sh` から source する。このファイル自体は実行しない。
#
# ## なぜ必要か
#
# 質問セッションは`--add-dir`で**各リポジトリの本体チェックアウト**（`~/apps/<repo>`）を参照して
# いた。本体チェックアウトを更新する仕組みはどこにも無く（`start-issue.sh`は「本体の作業ツリーには
# 触れない」ことを設計上の約束にしている）、**誰も`git pull`しない限り古いまま**になる。
#
# 2026-08-17の実測では、`git fetch`し直した後でも shopping-list が29コミット、car-care が24、
# dayspan が21、issue-deck 自身は`main`に乗ったまま67コミット遅れていた。質問の主用途はコード調査で、
# 回答は「いまのdevelopがどうなっているか」を前提に読まれる。**古いコードを根拠に自信を持って
# 答えるのは、いちばん困る壊れ方**（#1290がStep 4「チェックアウトの鮮度」として挙げていた懸念）。
#
# ## どう直すか
#
# ランチャーが起動時に各リポジトリを`fetch`し、**リポジトリごとに固定のdetached worktree**を
# `origin/develop`へ合わせて、そこを`--add-dir`で渡す。
#
#   ~/apps/issue-deck-worktrees/.questions/_refs/<owner>-<repo>
#
# **本体の作業ツリーには一切触れない。** `git worktree add`が書くのは本体リポジトリの
# `.git/worktrees/`だけで、チェックアウト中のブランチも未コミットの変更も動かさない
# （developを見るためのworktreeを作る`scripts/start-develop-dev.sh`と同じ手口）。
#
# 質問セッションごとには分けず**リポジトリごとに固定**するのは、`_session-<repo>`（#1529）と同じ
# 理由に加え、質問のたびに19リポジトリぶんのチェックアウトを作り直すのが無駄なため。すでに同じ
# コミットなら`checkout`すら走らない。
#
# **副作用として、他セッションが編集中の未コミットの変更は質問セッションから見えなくなる。**
# 「いま誰かが書いている途中のもの」ではなく「developがどうなっているか」を答える器に振り切る。
#
# ## 止めないこと
#
# fetchに失敗した・`origin/develop`も`origin/main`も無い・worktreeを用意できなかった場合は、
# **そのリポジトリだけ本体チェックアウトへ落として続ける**。参照先が1つ古いことより、質問に
# 答えられないことのほうが困る。落ちたリポジトリは参照一覧に理由付きで出るので、回答を読む側が
# 割り引いて読める。
#
# 環境変数:
#   ISSUE_DECK_QUESTION_BASE            質問セッションの作業ディレクトリの置き場（`_refs`はこの直下）
#   ISSUE_DECK_QUESTION_FETCH_TIMEOUT   1リポジトリのfetchに被せる制限時間・秒（既定15）

# fetchは全リポジトリぶんを並列で走らせるため、1件が詰まっても全体は止まらない。それでも上限を
# 付けるのは、`timeout`が無い環境や認証待ちで固まる経路を残さないため。
QUESTION_REFS_FETCH_TIMEOUT="${ISSUE_DECK_QUESTION_FETCH_TIMEOUT:-15}"

# スナップショットの置き場。`.questions/`直下に置くことで、質問セッションまわりの生成物が
# 1か所にまとまる（`scripts/cleanup-worktrees.sh`が触るのは`$WORKTREE_BASE/issue-*`だけなので、
# ここが掃除で消えることはない）。
question_refs_base_dir() {
  local base="${ISSUE_DECK_QUESTION_BASE:-$HOME/apps/issue-deck-worktrees/.questions}"
  printf '%s' "$base/_refs"
}

# `owner/repo` → ディレクトリ名。**ownerを落とさない。** リポジトリ名だけにすると、別ownerの
# 同名リポジトリが対応表に載った時点で同じディレクトリを奪い合う。
question_refs_safe_name() {
  printf '%s' "${1//[^A-Za-z0-9_-]/-}"
}

# 基準ref。`origin/develop` → `origin/main` の順に、**このホストが実際に持っているもの**を返す。
# どちらも無ければ1を返す（`develop`を持たないリポジトリと、fetchできたことのないリモート）。
question_refs_base_ref() {
  local repo_path="$1" ref
  for ref in origin/develop origin/main; do
    if git -C "$repo_path" rev-parse --verify --quiet "refs/remotes/$ref" >/dev/null 2>&1; then
      printf '%s' "$ref"
      return 0
    fi
  done
  return 1
}

# 1リポジトリぶんのfetch。**戻り値は常に0**（失敗はスナップショットの鮮度が古くなるだけで、
# 呼び出し側を止める理由にならない）。remote-trackingのrefだけを更新し、作業ツリーには触れない。
question_refs_fetch_one() {
  local repo_path="$1" branch runner=()
  command -v timeout >/dev/null 2>&1 && runner=(timeout "$QUESTION_REFS_FETCH_TIMEOUT")
  for branch in develop main; do
    if ${runner[@]+"${runner[@]}"} git -C "$repo_path" fetch --quiet origin "$branch" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 0
}

# 渡されたチェックアウトを**並列で**fetchする。直列にすると1件0.5秒でも19件で10秒かかり、
# 1件でも詰まればその分だけ質問の起動が遅れる。
question_refs_fetch_all() {
  local repo_path
  for repo_path in "$@"; do
    question_refs_fetch_one "$repo_path" &
  done
  wait || true
  return 0
}

# 本体チェックアウトへ落ちたときの説明。**どれくらい古いのかまで書く**（「本体を見ています」だけでは
# 回答を割り引いて読めない）。
question_refs_fallback_label() {
  local repo_path="$1" reason="$2" branch ref behind detail

  branch="$(git -C "$repo_path" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [[ -n "$branch" ]] || branch="不明"
  detail="本体チェックアウト・$branch"

  if ref="$(question_refs_base_ref "$repo_path")"; then
    behind="$(git -C "$repo_path" rev-list --count "HEAD..$ref" 2>/dev/null || true)"
    if [[ "$behind" =~ ^[0-9]+$ ]]; then
      detail+="・$ref から ${behind}コミット遅れ"
    fi
  fi
  printf '%s（%s）' "$detail" "$reason"
}

# スナップショットを`$sha`へ合わせる（ロックの内側）。用意できたら0を返す。
question_refs_sync_worktree_locked() {
  local repo_path="$1" dir="$2" sha="$3" base
  base="$(question_refs_base_dir)"

  # gitの作業ツリーとして壊れているものだけ作り直す。**消してよいのは`_refs`配下だと確かめた
  # パスだけ**（対応表のパスが書き換わっても、機械が`rm -rf`する先が外へ出ないようにする）。
  if [[ -e "$dir" ]] && ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    case "$dir" in
      "$base"/?*) rm -rf "$dir" 2>/dev/null || return 1 ;;
      *) return 1 ;;
    esac
  fi

  if [[ ! -e "$dir" ]]; then
    # 手で消された・掃除で消えたスナップショットの登録が残っていると`worktree add`が失敗する。
    git -C "$repo_path" worktree prune >/dev/null 2>&1 || true
    git -C "$repo_path" worktree add --detach --quiet "$dir" "$sha" >/dev/null 2>&1 || return 1
    return 0
  fi

  # すでにそのコミットなら何もしない（質問のたびに19リポジトリをcheckoutし直さない）。
  [[ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" == "$sha" ]] && return 0

  git -C "$dir" checkout --quiet --detach "$sha" >/dev/null 2>&1 && return 0
  # 追跡ファイルが書き換わっていた場合だけ強制する。ここは機械が管理する読み取り専用の置き場で、
  # 人が作業する場所ではない（質問セッションのcwdは`_session-<repo>`のほうで、Edit/Writeも封じてある）。
  git -C "$dir" checkout --quiet --force --detach "$sha" >/dev/null 2>&1 || return 1
  return 0
}

# 同時に走る質問セッションどうしが同じスナップショットを同時に触らないよう、リポジトリごとに
# ロックを取る。`flock`が無い環境ではロック無しで実行する（失敗すれば本体へ落ちるだけ）。
question_refs_sync_worktree() {
  local repo_path="$1" dir="$2" sha="$3" base lock rc lock_fd
  base="$(question_refs_base_dir)"
  mkdir -p "$base" 2>/dev/null || return 1

  if ! command -v flock >/dev/null 2>&1; then
    question_refs_sync_worktree_locked "$repo_path" "$dir" "$sha"
    return $?
  fi

  lock="$base/.$(basename "$dir").lock"
  exec {lock_fd}>"$lock" 2>/dev/null || return 1
  if ! flock -w 60 "$lock_fd" 2>/dev/null; then
    exec {lock_fd}>&-
    return 1
  fi
  question_refs_sync_worktree_locked "$repo_path" "$dir" "$sha"
  rc=$?
  exec {lock_fd}>&-
  return $rc
}

# 1リポジトリぶんの参照先を決める。**戻り値は常に0**で、結果は次のグローバルへ入れる
# （コマンド置換ではサブシェルになり、複数の値を呼び出し元へ返せないため）。
#
#   QUESTION_REF_DIR        `--add-dir`で渡すディレクトリ
#   QUESTION_REF_LABEL      参照一覧に添える鮮度の説明
#   QUESTION_REF_SNAPSHOT   1ならスナップショット、0なら本体チェックアウトへのフォールバック
#
# 呼ぶ前に `question_refs_fetch_all` を通しておくこと（ここではfetchしない。並列で済ませたものを
# 直列に引き直すと、その分だけ起動が遅くなる）。
question_ref_prepare() {
  local full_name="$1" repo_path="$2" ref sha dir

  QUESTION_REF_DIR="$repo_path"
  QUESTION_REF_LABEL=""
  QUESTION_REF_SNAPSHOT=0

  if ! ref="$(question_refs_base_ref "$repo_path")"; then
    QUESTION_REF_LABEL="$(question_refs_fallback_label "$repo_path" "origin/develop も origin/main も無い")"
    return 0
  fi

  sha="$(git -C "$repo_path" rev-parse --verify --quiet "$ref^{commit}" 2>/dev/null || true)"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    QUESTION_REF_LABEL="$(question_refs_fallback_label "$repo_path" "$ref のコミットを解決できない")"
    return 0
  fi

  dir="$(question_refs_base_dir)/$(question_refs_safe_name "$full_name")"
  if ! question_refs_sync_worktree "$repo_path" "$dir" "$sha"; then
    QUESTION_REF_LABEL="$(question_refs_fallback_label "$repo_path" "スナップショットを用意できなかった")"
    return 0
  fi

  QUESTION_REF_DIR="$dir"
  QUESTION_REF_SNAPSHOT=1
  QUESTION_REF_LABEL="$ref $(git -C "$dir" log -1 --format='%h・%cs' 2>/dev/null || printf '%s' "${sha:0:7}")"
  return 0
}
