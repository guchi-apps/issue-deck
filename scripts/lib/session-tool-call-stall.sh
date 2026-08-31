#!/usr/bin/env bash
# 「ツールを呼び出したつもりでテキストに書いただけで、実際には呼ばれていない」まま止まった
# セッションの検知（#2655）。
#
# ## 何が起きているか
#
# サブPCのキックオフ直後（Issueの実装を始めた最初のターン）で、Claude Codeが`Agent`ツール
# （大きな実装をforkへ委任する）を呼び出すつもりが、実際にはtool_useとして呼び出さず
# `Agent({ subagent_type: "fork", ... })`という**コード風のテキスト**を出力するだけで
# `stop_reason: end_turn`となりターンを終える、という誤動作を実地で確認した（直近3日で
# 調べた4セッション全てで発生）。
#
# このターン終了でも`Stop`フックは正常に発火するため、`lib/session-resume.sh`が扱う
# APIエラー（`isApiErrorMessage: true`でターンが打ち切られ`Stop`が飛ばない）とは別の現象で、
# 既存の自動再開の対象にならない。issue-deck側からは「正常に応答した」ように見えたまま、
# 実質何も進んでいないセッションが放置される。
#
# ## どう判定するか
#
# 転記の最後のやり取りが、
#   - `assistant`のメッセージで
#   - `tool_use`ブロックを1つも含まず（＝実際にはツールを呼んでいない）
#   - テキストに、既知のツール名＋`({`という関数呼び出し風の記法を含む
#   - かつ一定時間（既定15分）転記が更新されていない
# ことを条件にする。停滞時間の判定は`lib/session-resume.sh`の`session_resume_stalled_seconds`
# をそのまま使う（同じ「転記のmtimeからの経過秒数」という性質のため）。
#
# **自動での指示再送信は行わない。** research-desk#41の実例で、「進めて」という再送信のあとも
# モデルが「自分は先にツールを呼び出した」という誤った過去発言を事実と誤認し、`ListAgents`で
# 確認しても見つからないのに「まだバックグラウンドで動いている」と誤答して再び止まったことを
# 確認しており、固定文言の再送信では確実な復旧にならない（#1971の自動再開とはここが違う）。
# 検知したら1回だけ、issue-deckへ引き上げて人に判断してもらう。
#
# 判定材料はClaude Codeの転記フォーマットという内部仕様に依存するので、**読めなければ
# 「止まっていない」を返す**（＝これまでどおり止まったまま人を待つ）。
#
# このファイル自体は実行せず、source して使う。`lib/session-state.sh`・`lib/session-transcript.sh`・
# `lib/session-resume.sh`が先にsourceされている前提（`session_resume_stalled_seconds`を使うため）。

# この検知そのものを止めるスイッチ（0で無効）。
SESSION_TOOL_CALL_STALL_ENABLED="${SESSION_TOOL_CALL_STALL_ENABLED:-1}"
# 転記が更新されないまま経ったら「止まっている」とみなす分数。
# **APIエラー検知（10分）より長くしてあるのは、実際にAgent(fork)が起動できていて単に
# 時間がかかっているだけの正常なケースを早すぎる段階で誤検知しないため。**
SESSION_TOOL_CALL_STALL_MINUTES="${SESSION_TOOL_CALL_STALL_MINUTES:-15}"
# 転記の末尾から読む量。
SESSION_TOOL_CALL_STALL_TAIL_BYTES="${SESSION_TOOL_CALL_STALL_TAIL_BYTES:-65536}"
# 「ツール呼び出し風」とみなす記法。既知のツール名だけに絞ることで、説明用にコード片を
# 書いただけの正当なテキストを誤検知する可能性を下げる。
SESSION_TOOL_CALL_STALL_TOOL_PATTERN="${SESSION_TOOL_CALL_STALL_TOOL_PATTERN:-(Agent|Task|Bash|Read|Write|Edit|Grep|Glob|WebFetch|WebSearch|Artifact|NotebookEdit)\\(\\{}"

# 転記の末尾が「ツール呼び出しを書いたが実際には呼んでいない」形で終わっているか。
#
# **`system`など会話でないレコードは飛ばす。** 直後に`turn_duration`の`system`レコードが
# 必ず1件入るため。逆に、人やキューからの入力（`user`・`queue-operation`）が後ろにあれば
# 「もう誰かが動かした」ことになるので、その場合は末尾がこの形にならない。
session_tool_call_stall_transcript_untriggered() {
  local transcript="$1" last
  [[ -f "$transcript" ]] || return 1
  last="$(tail -c "$SESSION_TOOL_CALL_STALL_TAIL_BYTES" "$transcript" 2>/dev/null |
    grep -E '"type":"(assistant|user|queue-operation)"' | tail -1 || true)"
  [[ -n "$last" ]] || return 1
  printf '%s' "$last" | grep -q '"type":"assistant"' || return 1
  # tool_useを1つでも含んでいれば、実際にツールを呼んでいる＝この現象ではない。
  printf '%s' "$last" | grep -q '"type":"tool_use"' && return 1
  printf '%s' "$last" | grep -qE "$SESSION_TOOL_CALL_STALL_TOOL_PATTERN"
}

# そのセッションが、ツール呼び出しが実行されないまま停滞しているか。
# 判定できない・止まっていない場合は非0で返る（＝何もしない）。
session_tool_call_stall_detected() {
  local session="$1" transcript stalled stall_seconds
  [[ -n "$session" ]] || return 1
  [[ "$SESSION_TOOL_CALL_STALL_MINUTES" =~ ^[0-9]+$ ]] || return 1

  transcript="$(session_transcript_path "$session" 2>/dev/null || true)"
  [[ -n "$transcript" ]] || return 1

  stalled="$(session_resume_stalled_seconds "$transcript")" || return 1
  stall_seconds=$((SESSION_TOOL_CALL_STALL_MINUTES * 60))
  ((stalled >= stall_seconds)) || return 1

  session_tool_call_stall_transcript_untriggered "$transcript"
}
