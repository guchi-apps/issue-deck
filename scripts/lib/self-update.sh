#!/usr/bin/env bash
# 画面の「更新して再起動」（`SELF_UPDATE`ジョブ。#1875）で、`git pull`の前に作業ツリーを確かめる（#3588）。
#
# **汚れていたら原則として触らない。** 手で試した変更を巻き込んで消しうるため、失敗として人へ
# 返す。ただし#3588では、止まった理由が「作業ツリーに未コミットの変更があります」だけで、
# どのファイルかが画面から分からなかった（サブPCで`scripts/local-repo-ports.conf`が手で
# 書き換えられたまま残っていた）。そこで止まるときは**変更のあるファイル名を返す**。
#
# **失うものが無いときだけ捨てて続ける。** 変更のある追跡済みファイルが、`fetch`した後の
# 取り込み先（`@{u}`）と**すべて同じ内容**なら、その変更は取り込めば同じものが入るので
# 捨ててよい（手で当てた修正が、別経路で同じ形のままdevelopへ入った場合）。未追跡の
# ファイルがあるとき・取り込み先と1つでも違うときは捨てない。
#
# このファイル自体は実行せず、source して使う。

# 変更のあるファイル名を「a, b, c ほかN件」の形に縮める。stdinから1行1ファイルで受け取る。
self_update_summarize_files() {
  local -a files=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && files+=("$line")
  done
  local count="${#files[@]}" shown="" i
  for ((i = 0; i < count && i < 3; i++)); do
    shown+="${shown:+, }${files[$i]}"
  done
  if ((count > 3)); then
    shown+=" ほか$((count - 3))件"
  fi
  printf '%s' "$shown"
}

# 作業ツリーを`git pull --ff-only`できる状態にする。
#
# 引数: チェックアウトのディレクトリ
# 戻り値: 0＝続けてよい（元からきれい、または取り込み先と同じ変更だけを捨てた）
#         1＝止める。stdoutへ画面にそのまま出せる理由を書く
# 捨てたときは、何を捨てたかをstderrへ書く（pollerのログに残す）。
self_update_prepare_worktree() {
  local dir="$1" porcelain dirty_summary

  porcelain="$(git -C "$dir" status --porcelain 2>/dev/null)" || {
    printf '作業ツリーの状態を取得できませんでした。手元で確認してください。'
    return 1
  }
  [[ -z "$porcelain" ]] && return 0

  # porcelainの各行は「XY<空白>パス」。リネームは「元 -> 先」なので先だけを採る
  dirty_summary="$(printf '%s\n' "$porcelain" | cut -c4- | sed 's/.* -> //' | self_update_summarize_files)"
  local stop_message="作業ツリーに未コミットの変更があります（${dirty_summary}）。手元で確認してください。"

  if printf '%s\n' "$porcelain" | grep -q '^??'; then
    printf '%s' "$stop_message"
    return 1
  fi

  # 比較の前に取り込み先を最新にする（`pull`の前なので、しないと古い`@{u}`と比べてしまう）
  if ! timeout 120 git -C "$dir" fetch --quiet >/dev/null 2>&1 \
    || ! git -C "$dir" rev-parse --verify --quiet '@{u}' >/dev/null; then
    printf '%s' "$stop_message"
    return 1
  fi

  local -a files=()
  local file
  while IFS= read -r file; do
    [[ -n "$file" ]] && files+=("$file")
  done < <(git -C "$dir" diff --name-only HEAD --)
  if ((${#files[@]} == 0)) || ! git -C "$dir" diff --quiet '@{u}' -- "${files[@]}"; then
    printf '%s' "$stop_message"
    return 1
  fi

  if ! git -C "$dir" restore --source=HEAD --staged --worktree -- "${files[@]}" >/dev/null 2>&1 \
    || [[ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ]]; then
    printf '%s' "$stop_message"
    return 1
  fi
  echo "取り込み先と同じ内容の未コミットの変更を捨てました: ${dirty_summary}" >&2
  return 0
}

# 作業ツリーを整えてから`git pull --ff-only`する。画面の「更新して再起動」（`SELF_UPDATE`ジョブ）と
# pollerの自動更新（#4118）が同じ手順を踏むための共通部分。
#
# 引数: チェックアウトのディレクトリ
# 戻り値: 0＝取り込めた（または既に最新）。stdoutへ「<前> <後>」の短縮SHAを書く
#         1＝止めた。stdoutへ画面にそのまま出せる理由を書く
self_update_pull() {
  local dir="$1" reason before after out
  if ! reason="$(self_update_prepare_worktree "$dir")"; then
    printf '%s' "$reason"
    return 1
  fi
  before="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || true)"
  # **`--ff-only`。** マージコミットを作らず、分岐していれば失敗として返す
  if ! out="$(timeout 120 git -C "$dir" pull --ff-only 2>&1)"; then
    printf 'git pull --ff-only に失敗しました: %s' "$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    return 1
  fi
  after="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || true)"
  printf '%s %s' "$before" "$after"
  return 0
}

# 自動更新（#4118）が要るか。**ネットワークに触れず、手元のrefだけで決める**
# （originを見に行くのは`maybe_fetch_checkout`の間隔に任せる）。
#
# 引数: チェックアウトのディレクトリ、pollerの起動時のコミット（短縮SHA。空なら比べない）
# 戻り値: 0＝要る（追跡ブランチより遅れている、または起動時のコミットとHEADが食い違う）
#         1＝要らない
self_update_needed() {
  local dir="$1" started="$2" head upstream behind
  head="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null)" || return 1
  upstream="$(git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  if [[ -n "$upstream" ]]; then
    behind="$(git -C "$dir" rev-list --count "HEAD..$upstream" 2>/dev/null || true)"
    [[ "$behind" =~ ^[0-9]+$ ]] && ((behind > 0)) && return 0
  fi
  if [[ -n "$started" && "$head" != "$started"* && "$started" != "$head"* ]]; then
    return 0
  fi
  return 1
}

# 同じ失敗を繰り返さないための歯止め（#4118）。直近の失敗から`retry_minutes`分以内なら真。
# 失敗の記録は`state_file`の1行目（epoch秒）。**成功すれば消す**ので、成功→execの直後に
# 次のマージが来ても待たされない。
#
# 引数: 状態ファイル、再試行までの分数
self_update_in_backoff() {
  local state_file="$1" retry_minutes="$2" last now
  [[ -f "$state_file" ]] || return 1
  last="$(head -n1 "$state_file" 2>/dev/null || true)"
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  ((now - last < retry_minutes * 60))
}
