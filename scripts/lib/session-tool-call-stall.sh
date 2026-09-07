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
# ## 誰が起こしているか（#2896の実測）
#
# 直近45日ぶんの会話転記1,736件を機械的に走査した結果、この形の応答は**31件（29セッション）**
# あり、内訳は次のとおりだった。
#
#   - **31件すべてが`claude-sonnet-5`**。`claude-opus-5`は1,089セッションで0件
#   - **31件すべてが`Agent`ツール**。`subagent_type`は26件が`fork`（残りは`claude`など）
#   - **27件が最初のターン**（キックオフ文面への最初の応答）
#   - 実際に成功した`Agent`呼び出しのうち`fork`はsonnetの23件のみで、opusは1件も使っていない
#
# つまり「sonnet-5がキックオフでセッションの作業まるごとをforkへ委任しようとし、その呼び出しが
# tool_useにならずテキストで出る」現象で、sonnetで起動した152セッションの約19%で起きていた。
# **予防はキックオフ文面（`scripts/run-issue-session.sh`）にあり**、そこで丸投げ自体をやめる
# よう指示している。ここが扱うのは、それでも起きた場合の復旧。
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
# ## 検知したらどうするか（#2896で変更）
#
# **固定文面を自動で最大2回送り、それでも直らないときだけ人へ引き上げる。**
#
# #2655の時点では「自動での指示再送信は行わない」と決めていた。根拠はresearch-desk#41の実例で、
# 「進めて」という**曖昧な**再送信のあともモデルが「自分は先にツールを呼び出した」という誤った
# 過去発言を事実と誤認し、`ListAgents`で確認しても見つからないのに「まだバックグラウンドで
# 動いている」と誤答して再び止まった、というもの。
#
# その後に用意した固定文面（`SESSION_TOOL_CALL_STALL_BODY`。**呼ばれていないことを事実として
# 明言する**）は、#2896で実測したところ**29セッション中27セッションで復旧に成功**していた
# （残る2件は同じセッションで2回続けて再発）。一方、人が押すまでの放置時間は中央値12分・
# 最長5時間で、待たせている時間のほうが大きい。そこで、APIエラーの自動再開（#1971）と
# **同じ3条件**——固定文面・3段階プロトコル（`deliver_session_instruction`）・条件を確かめた
# セッションだけ——を満たす形で自動再送を開ける。上限を使い切ったら送るのをやめ、従来どおり
# issue-deckへ1度だけ引き上げて人へ渡す（画面の停滞パネルもそのまま残る）。
#
# 判定材料はClaude Codeの転記フォーマットという内部仕様に依存するので、**読めなければ
# 「止まっていない」を返す**（＝これまでどおり止まったまま人を待つ）。
#
# このファイル自体は実行せず、source して使う。`lib/session-state.sh`・`lib/session-transcript.sh`・
# `lib/session-resume.sh`が先にsourceされている前提（`session_resume_stalled_seconds`を使うため）。

# この検知そのものを止めるスイッチ（0で無効）。
SESSION_TOOL_CALL_STALL_ENABLED="${SESSION_TOOL_CALL_STALL_ENABLED:-1}"
# 転記が更新されないまま経ったら「止まっている」とみなす分数。
# **実際にAgent(fork)が起動できていて単に時間がかかっているだけの正常なケースは、
# 転記の最後がtool_useを含む形になるため、この閾値の長さに関わらず対象外になる**
# （`session_tool_call_stall_transcript_untriggered`がtool_use有無で先に弾く）。
# 15分から10分へ下げたのは、この現象に気づくまでの時間を縮めてほしいという要望のため（#2675）。
# **#2896でさらに3分へ下げた。** APIエラー（`lib/session-resume.sh`）と違って「エラーの直後に
# 自力で書き始めたturnへ割り込む」余地が無く——ターンは`Stop`まで終わっており、次に動くのは
# 人か再送信だけ——待っても判定材料は増えないため。判定条件そのものが排他（片方は転記末尾が
# APIエラー、もう片方はツール呼び出し風のテキスト）なので、APIエラー検知とも競合しない。
# 運用で調整したい場合は環境変数`SESSION_TOOL_CALL_STALL_MINUTES`
# （`deploy/subpc/dispatch.env.example`）で上書きする。
SESSION_TOOL_CALL_STALL_MINUTES="${SESSION_TOOL_CALL_STALL_MINUTES:-3}"
# 1つのセッションに対して自動で再送信を試みる回数の上限（#2896）。
# 実測では1回目で27/29が復旧し、駄目だったセッションは2回目も同じ形で失敗している。
# 3回目以降に意味が無いので、APIエラー再開（既定3回）より1つ少ない2回にしてある。
SESSION_TOOL_CALL_STALL_MAX_ATTEMPTS="${SESSION_TOOL_CALL_STALL_MAX_ATTEMPTS:-2}"
# 再送信を試みる間隔（分）。1回目を送った直後はセッションが動き出しているので、次の判定まで
# 間を置く（動き出していれば転記が更新され、そもそも検知の対象から外れる）。
SESSION_TOOL_CALL_STALL_INTERVAL_MINUTES="${SESSION_TOOL_CALL_STALL_INTERVAL_MINUTES:-3}"
# 転記の末尾から読む量。
SESSION_TOOL_CALL_STALL_TAIL_BYTES="${SESSION_TOOL_CALL_STALL_TAIL_BYTES:-65536}"
# 「ツール呼び出し風」とみなす記法。既知のツール名だけに絞ることで、説明用にコード片を
# 書いただけの正当なテキストを誤検知する可能性を下げる。
SESSION_TOOL_CALL_STALL_TOOL_PATTERN="${SESSION_TOOL_CALL_STALL_TOOL_PATTERN:-(Agent|Task|Bash|Read|Write|Edit|Grep|Glob|WebFetch|WebSearch|Artifact|NotebookEdit)\\(\\{}"

# 自動再送信で送る本文（#2896）。**固定文字列であることがこの仕組みの前提**
# （CLAUDE.md「監視・計画レビューを行う実行体の禁止事項」の例外は、状況を読んで返事を
# 組み立てないことで成り立っている）。
#
# **画面の停滞パネルが送るものと同じ1行**（`src/lib/dispatch/session-stall.ts`の
# `TOOL_CALL_STALL_BODY`）。片方だけ書き換えると、自動で送ったものと人が押して送ったもので
# 文面が食い違い、どちらが効いたのかを後から追えなくなる。**短く言い換えない**——
# 「呼ばれていない」ことを事実として明言するのがこの文面の要点で、「進めて」のような曖昧な
# 継続指示だと直前の自分の発言を「既に呼び出した」と誤認したまま再び止まる（#2655）。
#
# **1行・制御文字なし・500文字以内**（`send_session_instruction`の検証と同じ条件）。
SESSION_TOOL_CALL_STALL_BODY="${SESSION_TOOL_CALL_STALL_BODY:-直前の応答はツール呼び出し風のテキストを出力しただけで、実際にはツールは呼ばれていません。バックグラウンドで動いているものは何もありません。もう一度、実際にツールを呼び出して進めてください。}"

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

# --- 自動再送信の回数管理（#2896）--------------------------------------------
# 形も名前もAPIエラー再開（`lib/session-resume.sh`）に揃えてある。**同じ意味の関数を違う形で
# 持つと、片方だけ直したときに挙動がずれる。**

# 再送信の記録（`<最後に試した時刻> <試した回数> <通知したか>`）を読む。
# 記録が無ければ（＝まだ一度も試していない）`0 0 0`を返す。
# **#2896より前の形式（epochだけの1行）もここで`0 0 0`になる**（`session-state.sh`の説明を参照）。
session_tool_call_stall_read_state() {
  local session="$1" line
  line="$(session_state_read_tool_call_stall "$session" 2>/dev/null || true)"
  if [[ "$line" =~ ^([0-9]+)[[:space:]]+([0-9]+)[[:space:]]+([01])$ ]]; then
    printf '%s %s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    return 0
  fi
  printf '0 0 0'
}

# いま再送信を試してよいか。上限に達している・前回から間隔が空いていない場合は非0で返る。
session_tool_call_stall_due() {
  local session="$1" state last attempts now interval
  state="$(session_tool_call_stall_read_state "$session")"
  read -r last attempts _ <<<"$state"
  [[ "$SESSION_TOOL_CALL_STALL_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || return 1
  ((attempts < SESSION_TOOL_CALL_STALL_MAX_ATTEMPTS)) || return 1
  # 1回目は待たない。**止まっていることは既に停滞時間で確かめている。**
  ((attempts == 0)) && return 0
  [[ "$SESSION_TOOL_CALL_STALL_INTERVAL_MINUTES" =~ ^[0-9]+$ ]] || return 1
  interval=$((SESSION_TOOL_CALL_STALL_INTERVAL_MINUTES * 60))
  now="$(date +%s)"
  ((now - last >= interval))
}

# 上限を使い切ったか（＝人へ渡す段）。
session_tool_call_stall_exhausted() {
  local session="$1" state attempts
  state="$(session_tool_call_stall_read_state "$session")"
  read -r _ attempts _ <<<"$state"
  [[ "$SESSION_TOOL_CALL_STALL_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || return 1
  ((attempts >= SESSION_TOOL_CALL_STALL_MAX_ATTEMPTS))
}

# 人へ渡したことを既に通知したか。
session_tool_call_stall_notified() {
  local session="$1" state notified
  state="$(session_tool_call_stall_read_state "$session")"
  read -r _ _ notified <<<"$state"
  [[ "$notified" == "1" ]]
}

# 再送信を1回試したことを記録する。
session_tool_call_stall_record_attempt() {
  local session="$1" state last attempts notified
  state="$(session_tool_call_stall_read_state "$session")"
  read -r last attempts notified <<<"$state"
  session_state_write_tool_call_stall "$session" "$(date +%s)" "$((attempts + 1))" "$notified"
}

# 人へ渡したことを通知済みにする。
session_tool_call_stall_record_notified() {
  local session="$1" state last attempts
  state="$(session_tool_call_stall_read_state "$session")"
  read -r last attempts _ <<<"$state"
  session_state_write_tool_call_stall "$session" "$last" "$attempts" 1
}
