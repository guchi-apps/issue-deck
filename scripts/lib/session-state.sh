#!/usr/bin/env bash
# 実装セッション（tmux）の状態ファイル（#1256）。
#
# 誰が書いて誰が読むか:
#   scripts/run-issue-session.sh  起動時に記述子（<セッション名>.session）を書き、終了時に消す
#   scripts/session-notify.sh     Claude Codeのフックから、最後のイベント（<セッション名>.event）と
#                                 計画の承認待ちの印（<セッション名>.plan、#1342）を書く
#   scripts/reap-sessions.sh      両方を読み、作業が終わったセッションを畳む
#
# **キーはtmuxのセッション名。** 回収側がtmuxから得られる唯一の識別子で、worktreeの置き場は
# リポジトリごとに違い（`~/apps/<リポジトリ名>-worktrees`）、Issue番号はリポジトリごとに振られるため
# 番号だけでは別リポジトリのセッションと衝突する（#1224）。
#
# **`Stop`フックの時刻はこれまでどこにも残っていなかった。** #1219 の通知はSignalyへ投げるだけで、
# 送信先を設定していないホストでは何も残らない。「最後のStopからの経過時間」を回収の判定材料に
# するには、通知とは別にホスト側へ記録する必要がある。
#
# 形式をJSONにしないのは、読むのがシェルスクリプトだけで、回収スクリプトに`jq`・`python3`への
# 依存を持ち込みたくないため。値は改行を含まない1行の `key=value` にする。
# **読むときに`source`しない**（状態ファイルが書き換えられた場合にコードとして動くのを避ける）。
#
# このファイル自体は実行せず、source して使う。

# 置き場。`~/.config/issue-deck/`（設定）とworktree置き場（成果物）のどちらでもない、
# 「消えても作り直せる状態」なのでXDGのstateディレクトリに置く。
session_state_dir() {
  printf '%s' "${ISSUE_DECK_SESSION_STATE_DIR:-$HOME/.local/state/issue-deck/sessions}"
}

# tmuxのセッション名をファイル名として扱ってよいか。
# 名前はtmuxから読んだ値がそのまま来る（人が手で立てたセッションも混ざる）ため、パス区切りや
# 先頭のドットを含むものは弾く。ランチャーが付ける`<リポジトリ名>-issue-<番号>`は必ず通る。
session_state_name_ok() {
  local name="${1:-}"
  [[ -n "$name" ]] || return 1
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]
}

session_state_descriptor_file() {
  session_state_name_ok "${1:-}" || return 1
  printf '%s/%s.session' "$(session_state_dir)" "$1"
}

session_state_event_file() {
  session_state_name_ok "${1:-}" || return 1
  printf '%s/%s.event' "$(session_state_dir)" "$1"
}

session_state_reason_file() {
  session_state_name_ok "${1:-}" || return 1
  printf '%s/%s.reason' "$(session_state_dir)" "$1"
}

# 計画を投稿して `00.check-user` を付けたことの印（#1342）。
# **ラベルを外してよいのは自分で付けたときだけ**なので、それをどこかに覚えておく必要がある。
# issue-deck側のDBではなくホストに置くのは、`/api/dispatch/sessions/activity` が
# `ALIVE` のDispatchSessionの行が無ければ何もしない仕様で、pollerが1巡する前に計画が出ると
# 記録できず、ラベルだけ付いて外れなくなるため。
session_state_plan_file() {
  session_state_name_ok "${1:-}" || return 1
  printf '%s/%s.plan' "$(session_state_dir)" "$1"
}

# 書きかけを読まれないよう、一時ファイルへ書いてから置き換える。
# **失敗しても呼び出し元を止めない**（記録できないだけで、セッションの起動も通知も続けられる）。
session_state_write_file() {
  local file="$1" content="$2" tmp
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 1
  tmp="$file.tmp.$$"
  printf '%s' "$content" >"$tmp" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null
    return 1
  }
  mv -f "$tmp" "$file" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null
    return 1
  }
}

# 起動時の記述子を書く。`reapable`が1のセッションだけが自動回収の対象になる。
session_state_write_descriptor() {
  local session="$1" worktree="$2" repository="$3" issue_number="$4" reapable="$5"
  local file content
  file="$(session_state_descriptor_file "$session")" || return 1
  printf -v content 'session=%s\nworktree=%s\nrepository=%s\nissue=%s\nreapable=%s\nstartedAt=%s\n' \
    "$session" "$worktree" "$repository" "$issue_number" "$reapable" "$(date +%s)"
  session_state_write_file "$file" "$content"
}

# 記述子から1つの値を取り出す。見つからなければ非0で返る。
session_state_field() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$file"
  return 1
}

# フックのイベント（`Stop` / `permission_prompt` / `working`）を記録する。
# 毎回上書きし、最後の1件だけを残す。
#
# `working`は「入力待ちに人が答えて作業へ戻った」（#1357）。**記録すること自体が間引きの要**で、
# `session-notify.sh`は`permission_prompt`が残っている`PostToolUse`だけを扱うため、1回書いた
# 時点で以降のツール実行では何もしなくなる。
session_state_record_event() {
  local session="$1" event="$2" file content
  file="$(session_state_event_file "$session")" || return 1
  printf -v content '%s %s\n' "$(date +%s)" "$event"
  session_state_write_file "$file" "$content"
}

# 計画を投稿して `00.check-user` を付けたことを記録する（#1342）。
session_state_mark_plan_pending() {
  local session="$1" file content
  file="$(session_state_plan_file "$session")" || return 1
  printf -v content '%s pending\n' "$(date +%s)"
  session_state_write_file "$file" "$content"
}

# 計画の承認待ちの印があるか。**あるときだけラベルを外す**。
session_state_plan_pending() {
  local session="$1" file
  file="$(session_state_plan_file "$session")" || return 1
  [[ -f "$file" ]]
}

# 印を消す（ラベルを外し終えたとき）。無ければ何もしない。
session_state_clear_plan_pending() {
  local session="$1" file
  file="$(session_state_plan_file "$session")" || return 1
  rm -f "$file" 2>/dev/null || true
  return 0
}

# 記録した最後のイベントを `<epoch> <イベント名>` の形で返す。
session_state_read_event() {
  local session="$1" file
  file="$(session_state_event_file "$session")" || return 1
  [[ -f "$file" ]] || return 1
  head -1 "$file" 2>/dev/null
}

# 同じ理由を毎巡ログへ出さないための記録。**前回と違う理由のときだけ0を返す。**
# pollerは60秒ごとに呼ばれるため、状態だけで出し分けるとjournaldが同じ行で埋まる
# （docs/multi-agent/gates.md「同じ状態が続く間は投稿し直さない」と同じ考え方）。
session_state_reason_changed() {
  local session="$1" reason="$2" file previous
  file="$(session_state_reason_file "$session")" || return 0
  previous="$(cat "$file" 2>/dev/null || true)"
  [[ "$previous" != "$reason" ]] || return 1
  session_state_write_file "$file" "$reason" || true
  return 0
}

# そのセッションの状態ファイルをすべて消す。**セッションを畳んだ後と、セッションが自然に
# 終わったときの両方で呼ぶ。** 残すと、次に同じ名前で立ったセッションが前回のイベントを
# 引き継いだように見える。
session_state_remove() {
  local session="$1" file
  for file in \
    "$(session_state_descriptor_file "$session" 2>/dev/null || true)" \
    "$(session_state_event_file "$session" 2>/dev/null || true)" \
    "$(session_state_reason_file "$session" 2>/dev/null || true)" \
    "$(session_state_plan_file "$session" 2>/dev/null || true)"; do
    [[ -n "$file" ]] || continue
    rm -f "$file" 2>/dev/null || true
  done
  return 0
}
