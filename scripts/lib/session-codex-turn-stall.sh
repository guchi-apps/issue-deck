#!/usr/bin/env bash
# Codexのセッションが「ターンを始めたまま終えていない」形で止まったことの検知（#3174）。
#
# ## 何が起きているか
#
# Codexの転記（`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`）は、ターンの開始で
# `event_msg`の`task_started`、終了で`task_complete`、Ctrl-Cでの中断で`turn_aborted`を書く。
# 正常に流れたターンは必ずこのどれかで閉じる。ところが**開始だけ書かれて、どれも来ないまま
# 更新が止まる**ことがあり、このときセッションはtmuxの中で生きたまま何もしなくなる。
#
# `lib/session-resume.sh`が拾うAPIエラー（`task_complete`に`error`が入る形。#3178）とは
# **条件が排他**で、あちらは「ターンが閉じている」ことが前提。こちらはターンが閉じていない。
#
# ## 実測（2026-09-20・サブPCの転記74件）
#
#   - `task_started` 141 / `task_complete` 129 / `turn_aborted` 5。差の7件が「開始したまま
#     閉じていない」ターンで、1件は実行中、6件は過去に消えたセッションだった
#   - **ターンの中のレコード間隔は最大103秒**（120秒を超えたファイルは74件中0件）。長くかかる
#     ツール実行でもこの程度しか空かないため、既定10分の閾値なら誤検知しない
#
# ## どう判定するか
#
# 転記に出てくる`task_started` / `task_complete` / `turn_aborted`のうち**最後のものが
# `task_started`**で、かつ一定時間（既定10分）転記が更新されていないこと。停滞時間の判定は
# `lib/session-resume.sh`の`session_resume_stalled_seconds`をそのまま使う。
#
# **末尾だけを切り出さず、転記全体からマーカーを拾う。** ツール出力が大きいターンでは末尾
# 64KiBに`task_started`が入らず、「マーカーが1つも無い」＝検知せず、へ落ちてしまう。
# マーカーは転記1件あたり数個しか無いので、全体をgrepしても読む量に見合う。
#
# ## 検知したらどうするか
#
# **固定文面を`codex queue`で最大3回まで送り、それでも直らないときだけ人へ引き上げる。**
# 回数・間隔・上限後の引き上げは`lib/session-resume.sh`（APIエラー）に揃えてある。
#
# 送り方が`send-keys`ではなく`codex queue`なので、[docs/multi-agent/gates.md]の例外
# （実行体が組み立てた文字列のtmuxへの送出）を新しく開ける必要が無い——`deliver_session_instruction`が
# エージェント種別を見て`codex queue`へ振る（`lib/codex-queue.sh`）。
#
# 判定材料はCodexの内部フォーマットなので、**読めなければ「止まっていない」を返す**
# （＝これまでどおり止まったまま人を待つ）。
#
# このファイル自体は実行せず、source して使う。`lib/session-state.sh`・`lib/session-transcript.sh`・
# `lib/session-resume.sh`が先にsourceされている前提（`session_resume_stalled_seconds`を使うため）。

# この検知そのものを止めるスイッチ（0で無効）。
SESSION_CODEX_TURN_STALL_ENABLED="${SESSION_CODEX_TURN_STALL_ENABLED:-1}"
# 転記が更新されないまま経ったら「止まっている」とみなす分数。
# **APIエラー再開（既定10分）と同じにしてある。** 実測のターン内間隔が最大103秒なので、
# 10分あれば長いツール実行の途中へ割り込む余地はほぼ無い。
SESSION_CODEX_TURN_STALL_MINUTES="${SESSION_CODEX_TURN_STALL_MINUTES:-10}"
# 1つのセッションに対して自動で送り直す回数の上限。使い切ったら以降は送らず、issue-deckへ
# 1度だけ引き上げて人へ渡す（Issueコメント＋`00.check-user`＋`01.check-blocked`）。
SESSION_CODEX_TURN_STALL_MAX_ATTEMPTS="${SESSION_CODEX_TURN_STALL_MAX_ATTEMPTS:-3}"
# 送り直す間隔（分）。
SESSION_CODEX_TURN_STALL_INTERVAL_MINUTES="${SESSION_CODEX_TURN_STALL_INTERVAL_MINUTES:-5}"

# 送る本文。**固定文字列であることがこの仕組みの前提**（CLAUDE.md「監視・計画レビューを行う
# 実行体の禁止事項」の例外は、状況を読んで返事を組み立てないことで成り立っている）。
#
# **画面の停滞パネルが送るものと同じ1行**（`src/lib/dispatch/session-stall.ts`の
# `TURN_STALL_BODY`）。片方だけ書き換えると、自動で送ったものと人が押して送ったもので文面が
# 食い違い、どちらが効いたのかを後から追えなくなる。
#
# **1行・制御文字なし・500文字以内**（`send_session_instruction`の検証と同じ条件）。
# 先頭を`/`や`!`にしない（スラッシュコマンド・Bashモードとして解釈される）。
SESSION_CODEX_TURN_STALL_BODY="${SESSION_CODEX_TURN_STALL_BODY:-直前のターンが完了しないまま中断しています。中断したところから作業を続けてください。}"

# 転記のターンが閉じていない（＝最後のターンマーカーが`task_started`）か。
#
# `"type":"event_msg"`を含む行だけに絞ってから拾う。ターンマーカーはすべて`event_msg`の
# `payload.type`で、`compacted`や`response_item`（モデルの出力やツールの入出力）に同じ
# 文字列が混じっても拾わないため。
session_codex_turn_stall_transcript_unfinished() {
  local transcript="$1" last
  [[ -f "$transcript" ]] || return 1
  last="$(grep -E '"type":"event_msg"' "$transcript" 2>/dev/null |
    grep -oE '"type":"(task_started|task_complete|turn_aborted)"' | tail -1 || true)"
  [[ "$last" == '"type":"task_started"' ]]
}

# そのセッションが、ターンを始めたまま停滞しているか。
# 判定できない・止まっていない場合は非0で返る（＝何もしない）。
session_codex_turn_stall_detected() {
  local session="$1" transcript stalled stall_seconds
  [[ -n "$session" ]] || return 1
  [[ "$SESSION_CODEX_TURN_STALL_MINUTES" =~ ^[0-9]+$ ]] || return 1
  # **Codexのセッションだけを対象にする。** Claude Codeの転記には`event_msg`が無いので
  # 実害は無いが、転記を丸ごとgrepする処理なので入口で弾く。
  [[ "$(session_state_agent_kind "$session" 2>/dev/null || true)" == "codex" ]] || return 1

  transcript="$(session_transcript_path "$session" 2>/dev/null || true)"
  [[ -n "$transcript" ]] || return 1

  stalled="$(session_resume_stalled_seconds "$transcript")" || return 1
  stall_seconds=$((SESSION_CODEX_TURN_STALL_MINUTES * 60))
  ((stalled >= stall_seconds)) || return 1

  session_codex_turn_stall_transcript_unfinished "$transcript"
}

# そのセッションのターンが閉じたか（＝記録を消してよいか）。
#
# **回数の記録を消す条件を「検知しなくなったら」にしない。** 検知には停滞時間が入っている
# ため、送った直後にCodexが動き出せば時間条件だけで外れ、回数が毎回0へ戻って上限が効かなく
# なる（#2896で`session_tool_call_stall_recovered`が解いたのと同じ穴）。ここでは時間を見ずに
# **ターンが閉じたことだけ**を条件にするので、`codex queue`が転記を更新するかどうかに
# 依存しない。
#
# **読めなければ「閉じていない」を返す**（＝記録を残す）。取りこぼしても、次に同じ形で
# 止まったときに1回早く人へ渡るだけで、送り続ける側には倒れない。
session_codex_turn_stall_settled() {
  local session="$1" transcript
  transcript="$(session_transcript_path "$session" 2>/dev/null || true)"
  [[ -n "$transcript" ]] || return 1
  ! session_codex_turn_stall_transcript_unfinished "$transcript"
}

# --- 自動送信の回数管理 --------------------------------------------------------
# 形も名前もAPIエラー再開（`lib/session-resume.sh`）に揃えてある。**同じ意味の関数を違う形で
# 持つと、片方だけ直したときに挙動がずれる。**

# 送信の記録（`<最後に試した時刻> <試した回数> <通知したか>`）を読む。
# 記録が無ければ（＝まだ一度も試していない）`0 0 0`を返す。
session_codex_turn_stall_read_state() {
  local session="$1" line
  line="$(session_state_read_codex_turn_stall "$session" 2>/dev/null || true)"
  if [[ "$line" =~ ^([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([01])$ ]]; then
    printf '%s %s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    return 0
  fi
  printf '0 0 0'
}

# いま送信を試してよいか。上限に達している・前回から間隔が空いていない場合は非0で返る。
session_codex_turn_stall_due() {
  local session="$1" state last attempts now interval
  state="$(session_codex_turn_stall_read_state "$session")"
  read -r last attempts _ <<<"$state"
  [[ "$SESSION_CODEX_TURN_STALL_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || return 1
  ((attempts < SESSION_CODEX_TURN_STALL_MAX_ATTEMPTS)) || return 1
  # 1回目は待たない。**止まっていることは既に停滞時間で確かめている。**
  ((attempts == 0)) && return 0
  [[ "$SESSION_CODEX_TURN_STALL_INTERVAL_MINUTES" =~ ^[0-9]+$ ]] || return 1
  interval=$((SESSION_CODEX_TURN_STALL_INTERVAL_MINUTES * 60))
  now="$(date +%s)"
  ((now - last >= interval))
}

# 上限を使い切ったか（＝人へ渡す段）。
session_codex_turn_stall_exhausted() {
  local session="$1" state attempts
  state="$(session_codex_turn_stall_read_state "$session")"
  read -r _ attempts _ <<<"$state"
  [[ "$SESSION_CODEX_TURN_STALL_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || return 1
  ((attempts >= SESSION_CODEX_TURN_STALL_MAX_ATTEMPTS))
}

# 人へ渡したことを既に通知したか。
session_codex_turn_stall_notified() {
  local session="$1" state notified
  state="$(session_codex_turn_stall_read_state "$session")"
  read -r _ _ notified <<<"$state"
  [[ "$notified" == "1" ]]
}

# 送信を1回試したことを記録する。
session_codex_turn_stall_record_attempt() {
  local session="$1" state last attempts notified
  state="$(session_codex_turn_stall_read_state "$session")"
  read -r last attempts notified <<<"$state"
  session_state_write_codex_turn_stall "$session" "$(date +%s)" "$((attempts + 1))" "$notified"
}

# 人へ渡したことを通知済みにする。
session_codex_turn_stall_record_notified() {
  local session="$1" state last attempts
  state="$(session_codex_turn_stall_read_state "$session")"
  read -r last attempts _ <<<"$state"
  session_state_write_codex_turn_stall "$session" "$last" "$attempts" 1
}
