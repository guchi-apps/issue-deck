#!/usr/bin/env bash
# APIエラー（529 Overloaded など）で中断した実装セッションの検知（#1971）。
#
# ## 何が起きているか
#
# Claude Codeはサーバー側の一時エラーを既定10回まで再試行し、それでも駄目なら
# `API Error: 529 Overloaded. ...` と表示して**そのturnを打ち切る**。セッション自体は生きたまま
# 入力欄へ戻るが、このとき**`Stop`フックは飛ばない**（2026-08-18の実測。下記）。つまり、
#
#   - 画面にも通知にも「止まった」と伝わらない（人は気づけない）
#   - 状態ファイル（`lib/session-state.sh`の`.event`）は`working`のまま止まる
#   - 回収（`reap-sessions.sh`）は`Stop`しか畳まないので、セッションは残り続ける
#   - 画面の「追加指示を送る」も1a（最後のイベントが`Stop`）で弾かれ、人が送ることもできない
#
# 2026-08-18 16:12〜16:37（UTC）に6セッション（issue-deck #1947・#1956・#1962・#1964、
# aide #35・#89）が同時にこれで止まり、人が端末から「続けて」と打つ 21:55 まで5時間半
# 動かなかった。転記の最後は例外なく `isApiErrorMessage: true` のレコードで終わっている。
#
# ## どう判定するか
#
# **転記の末尾だけを見る。** 画面（`capture-pane`）の文字列から状態を推定する方式は実地で
# 誤判定した実績があり（#1219・#1223）、こちらは「最後のレコードがAPIエラーである」という
# 構造化された事実を1つ読むだけで済む。加えて**停滞時間**（転記が更新されていない時間）を
# 条件に入れ、エラー直後にClaude Code自身が続きを書き始めた場合を拾わない。
#
# 判定材料はいずれもClaude Codeの内部仕様なので、**読めなければ「中断していない」を返す**
# （＝これまでどおり止まったまま人を待つ）。
#
# このファイル自体は実行せず、source して使う。`lib/session-state.sh` と
# `lib/session-transcript.sh` が先にsourceされている前提。

# 自動再開そのものを止めるスイッチ（0で無効）。設定は `~/.config/issue-deck/dispatch.env`。
SESSION_RESUME_ENABLED="${SESSION_RESUME_ENABLED:-1}"
# 転記が更新されないまま経ったら「止まっている」とみなす分数。
# **短くすると、エラーの直後に自力で書き始めたturnへ割り込む。**
SESSION_RESUME_STALL_MINUTES="${SESSION_RESUME_STALL_MINUTES:-10}"
# 1つのセッションに対して自動で再開を試みる回数の上限。
# 使い切ったら以降は送らず、issue-deckへ1度だけ引き上げて人へ渡す
# （#2280。Issueコメント＋`00.check-user`＋`01.check-blocked`が付く）。
SESSION_RESUME_MAX_ATTEMPTS="${SESSION_RESUME_MAX_ATTEMPTS:-3}"
# 再開を試みる間隔（分）。過負荷が続いている間に連打しても同じことになるため間を置く。
SESSION_RESUME_INTERVAL_MINUTES="${SESSION_RESUME_INTERVAL_MINUTES:-5}"
# 転記の末尾から読む量。長いセッションでは数MBになるため全部は読まない。
SESSION_RESUME_TAIL_BYTES="${SESSION_RESUME_TAIL_BYTES:-65536}"

# 送る本文。**固定文字列であることがこの仕組みの前提**（CLAUDE.md「監視・計画レビューを行う
# 実行体の禁止事項」の例外は、状況を読んで返事を組み立てないことで成り立っている）。
# 状況に応じて本文を変えたくなったら、それは人が送るべきもの（画面の「追加指示を送る」）。
#
# **1行・制御文字なし・500文字以内**（`send_session_instruction`の検証と同じ条件）。
# 先頭を`/`や`!`にしない（スラッシュコマンド・Bashモードとして解釈される）。
SESSION_RESUME_BODY="${SESSION_RESUME_BODY:-直前の応答がAPIエラーで中断しました。中断したところから作業を続けてください。}"

# 転記の末尾がAPIエラーで終わっているか。
#
# **`system`など会話でないレコードは飛ばす。** エラーの直後には`turn_duration`の`system`
# レコードが必ず1件入る。逆に、人が入力した（`user`・`queue-operation`）ぶんが後ろにあれば
# 「もう誰かが再開させた」ことになるので、その場合は末尾がエラーにならない。
session_resume_transcript_interrupted() {
  local transcript="$1" last
  [[ -f "$transcript" ]] || return 1
  last="$(tail -c "$SESSION_RESUME_TAIL_BYTES" "$transcript" 2>/dev/null |
    grep -E '"type":"(assistant|user|queue-operation)"' | tail -1 || true)"
  [[ -n "$last" ]] || return 1
  printf '%s' "$last" | grep -q '"isApiErrorMessage":true'
}

# 転記が最後に書かれてから経った秒数。読めなければ非0で返る。
session_resume_stalled_seconds() {
  local transcript="$1" mtime now
  mtime="$(stat -c %Y "$transcript" 2>/dev/null || true)"
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  printf '%s' "$((now - mtime))"
}

# そのセッションがAPIエラーで中断したまま止まっているか。
# 判定できない・止まっていない場合は非0で返る（＝何もしない）。
session_resume_interrupted() {
  local session="$1" transcript stalled stall_seconds
  [[ -n "$session" ]] || return 1
  [[ "$SESSION_RESUME_STALL_MINUTES" =~ ^[0-9]+$ ]] || return 1

  transcript="$(session_transcript_path "$session" 2>/dev/null || true)"
  [[ -n "$transcript" ]] || return 1

  stalled="$(session_resume_stalled_seconds "$transcript")" || return 1
  stall_seconds=$((SESSION_RESUME_STALL_MINUTES * 60))
  ((stalled >= stall_seconds)) || return 1

  session_resume_transcript_interrupted "$transcript"
}

# 再開の記録（`<最後に試した時刻> <試した回数> <通知したか>`）を読む。
# 記録が無ければ `0 0 0` を返す（まだ一度も試していない）。
session_resume_read_state() {
  local session="$1" line
  line="$(session_state_read_resume "$session" 2>/dev/null || true)"
  if [[ "$line" =~ ^([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([01])$ ]]; then
    printf '%s %s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    return 0
  fi
  printf '0 0 0'
}

# いま再開を試してよいか。上限に達している・前回から間隔が空いていない場合は非0で返る。
session_resume_due() {
  local session="$1" state last attempts now interval
  state="$(session_resume_read_state "$session")"
  read -r last attempts _ <<<"$state"
  [[ "$SESSION_RESUME_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || return 1
  ((attempts < SESSION_RESUME_MAX_ATTEMPTS)) || return 1
  # 1回目は待たない。**止まっていることは既に停滞時間で確かめている。**
  ((attempts == 0)) && return 0
  [[ "$SESSION_RESUME_INTERVAL_MINUTES" =~ ^[0-9]+$ ]] || return 1
  interval=$((SESSION_RESUME_INTERVAL_MINUTES * 60))
  now="$(date +%s)"
  ((now - last >= interval))
}

# 上限を使い切ったか（＝人へ渡す段）。
session_resume_exhausted() {
  local session="$1" state attempts
  state="$(session_resume_read_state "$session")"
  read -r _ attempts _ <<<"$state"
  [[ "$SESSION_RESUME_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || return 1
  ((attempts >= SESSION_RESUME_MAX_ATTEMPTS))
}

# 人へ渡したことを既に通知したか。
session_resume_notified() {
  local session="$1" state notified
  state="$(session_resume_read_state "$session")"
  read -r _ _ notified <<<"$state"
  [[ "$notified" == "1" ]]
}

# 再開を1回試したことを記録する。
session_resume_record_attempt() {
  local session="$1" state last attempts notified
  state="$(session_resume_read_state "$session")"
  read -r last attempts notified <<<"$state"
  session_state_write_resume "$session" "$(date +%s)" "$((attempts + 1))" "$notified"
}

# 人へ渡したことを通知済みにする。
session_resume_record_notified() {
  local session="$1" state last attempts
  state="$(session_resume_read_state "$session")"
  read -r last attempts _ <<<"$state"
  session_state_write_resume "$session" "$last" "$attempts" 1
}
