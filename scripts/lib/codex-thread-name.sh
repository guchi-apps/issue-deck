#!/usr/bin/env bash
# Codexのセッションに`<リポジトリ名> #<Issue番号>`の名前を付ける（#2540）。
#
# **これはRemote Controlの代わりになる。** Claude Code側（#1219）はセッションごとのURLが取れる
# ので、Issueの画面から「そのIssueのセッション」を直接開ける。Codexが出すのはホスト単位の
# ペアリングコードだけ（#2524・#2537）で、繋いだChatGPTアプリに出るのは**そのホストのCodex
# セッション全部**の一覧になる。**見えてはいるが、どれがどのIssueか分からない**——名前を決めるのは
# Codex側（モデルが自動で付ける）で、実機の一覧は「実装する codex使用量表示」「Issue #2520を
# 引き継ぐ」のように規則が無い。名前を`issue-deck #2537`に揃えれば、一覧から選べる。
#
# #2510の時点では「セッション名は付けられない」としていたが、それは`codex --help`・
# `codex exec --help`のオプションと`codex agents`のTUIしか見ていなかった。**app-serverの
# JSON-RPCに`thread/name/set`がある**（実機・codex-cli 0.151.0で確認）。
#
#   {"id":2,"method":"thread/name/set","params":{"threadId":"<UUID>","name":"issue-deck #2540"}}
#   → {"id":2,"result":{}} ＋ 通知 {"method":"thread/name/updated",…}
#
# 実機で分かっていること。
#
#   - **デーモンは要らない。** `codex agents`・`codex remote-control`と違い、stdioの
#     `codex app-server`を1回起こすだけでよい（`codex queue`と同じ。#2519）
#   - **`codex app-server proxy`（走っているデーモンの制御ソケットへの中継）では応答が返らない。**
#     NDJSON・`Content-Length`の両方で無反応だったため、stdioの`codex app-server`を使う
#   - **走っているセッションにも効く。** tmuxで起こしたTUIのスレッドへ付け替えられる。
#     ただし**モデルの自動命名に上書きされる**（#2540では「されない」としていたが誤り。
#     下の「付けた名前は、モデルの自動命名で上書きされる」）
#   - **stdinを閉じるとリクエストを処理せずに終了する**（200msで抜ける）。そのため応答を
#     読み終えるまでstdinを開けておく（下の`coproc`）
#   - 知らないスレッドIDには`{"error":{"code":-32600,"message":"no rollout found for thread id …"}}`
#     を返す。**セッション開始の直後は転記がまだ無いことがある**ので、そのときだけ数回やり直す
#
# このファイル自体は実行せず、source して使う。宛先（スレッドUUID）の置き場は
# `lib/session-state.sh`の`.codex-thread`で、書くのは`session-notify.sh`の`SessionStart`。

# 実行する`codex`。**差し替えられるのは検証のときだけ**で、pollerは既定のまま使う
# （`codex-queue.sh`と同じ変数を見る。同じホストの同じ実体を指すため）。
CODEX_THREAD_NAME_COMMAND="${ISSUE_DECK_CODEX_COMMAND:-codex}"

# `codex app-server`の打ち切り（秒）。**待たされ続けないための保険。**
CODEX_THREAD_NAME_TIMEOUT_SECONDS="${ISSUE_DECK_CODEX_NAME_TIMEOUT_SECONDS:-20}"

# 応答を待つ長さ（秒）。実機では起動から応答まで0.3秒ほど。
CODEX_THREAD_NAME_READ_SECONDS="${ISSUE_DECK_CODEX_NAME_READ_SECONDS:-15}"

# 転記がまだ無いとき（`no rollout found`）のやり直し。**セッション開始の直後だけの状態**なので、
# 短い間隔で数回試して、それでも駄目なら諦める（名前が付かないだけで、セッションは動く）。
CODEX_THREAD_NAME_ATTEMPTS="${ISSUE_DECK_CODEX_NAME_ATTEMPTS:-3}"
CODEX_THREAD_NAME_RETRY_SECONDS="${ISSUE_DECK_CODEX_NAME_RETRY_SECONDS:-2}"

# JSONの文字列として安全な形にする。`"`と`\`だけを潰し、制御文字は落とす。
# **名前は`<リポジトリ名> #<Issue番号>`**なので実際には何も起きないが、呼び出し元が
# 別の文字列を渡してもJSONが壊れないようにしておく。
codex_thread_name_escape() {
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# 名前を1回設定する。
#
# 返り値: 0=付けた / 2=付けられなかった（異常）/ 3=まだ転記が無い（やり直す価値がある）。
# 2・3のときは理由を標準出力へ1行で返す（`codex_queue_send`と同じ規約）。
codex_thread_name_call() {
  local thread="$1" name="$2" line result="" status=0
  local init='{"id":1,"method":"initialize","params":{"clientInfo":{"name":"issue-deck","version":"1"}}}'
  local ready='{"method":"initialized","params":{}}'
  local request
  request="$(printf '{"id":2,"method":"thread/name/set","params":{"threadId":"%s","name":"%s"}}' \
    "$(codex_thread_name_escape "$thread")" "$(codex_thread_name_escape "$name")")"

  # **`coproc`で送りながら読む。** stdinを先に閉じると処理される前に終了してしまい、
  # 固定時間`sleep`で開けておくとセッション開始のたびにその秒数だけ待たされる。
  # 応答（`"id":2`）が来たらすぐ抜ける。
  coproc CODEX_NAME_PROC {
    timeout "$CODEX_THREAD_NAME_TIMEOUT_SECONDS" "$CODEX_THREAD_NAME_COMMAND" app-server 2>/dev/null
  }
  if ! printf '%s\n%s\n%s\n' "$init" "$ready" "$request" >&"${CODEX_NAME_PROC[1]}" 2>/dev/null; then
    codex_thread_name_close
    echo "codex app-server へ書き込めませんでした"
    return 2
  fi

  while IFS= read -r -t "$CODEX_THREAD_NAME_READ_SECONDS" line <&"${CODEX_NAME_PROC[0]}"; do
    case "$line" in
      *'"id":2'*)
        result="$line"
        break
        ;;
    esac
  done
  codex_thread_name_close

  if [[ -z "$result" ]]; then
    echo "codex app-server から応答がありませんでした"
    return 2
  fi
  if [[ "$result" == *'"result"'* ]]; then
    return 0
  fi
  # **「まだ転記が無い」だけは呼び出し元にやり直させる。** 他の失敗（版が違う・落ちた）を
  # やり直しても同じ結果にしかならない。
  if [[ "$result" == *"no rollout found"* ]]; then
    echo "セッションの転記がまだありません"
    return 3
  fi
  echo "thread/name/set に失敗しました: $(codex_thread_name_message "$result")"
  return 2
}

# coprocの後始末。**閉じてから待つ**——閉じないと`codex app-server`はstdinを読み続け、
# `timeout`が切れるまで残る。
codex_thread_name_close() {
  [[ -n "${CODEX_NAME_PROC[1]:-}" ]] && eval "exec ${CODEX_NAME_PROC[1]}>&-" 2>/dev/null
  [[ -n "${CODEX_NAME_PROC[0]:-}" ]] && eval "exec ${CODEX_NAME_PROC[0]}<&-" 2>/dev/null
  [[ -n "${CODEX_NAME_PROC_PID:-}" ]] && wait "$CODEX_NAME_PROC_PID" 2>/dev/null
  return 0
}

# エラー応答から`message`を1行で取り出す。取れなければ応答そのものを切って返す
# （**画面やログに出るのは1行**なので、複数行・長すぎるものを載せない）。
codex_thread_name_message() {
  local raw="$1" message
  message="$(printf '%s' "$raw" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p')"
  if [[ -n "$message" ]]; then
    printf '%s' "$message"
    return 0
  fi
  printf '%s' "${raw:0:200}"
}

# 名前を付ける（やり直しを含む）。
#
# 第1引数はスレッドUUID、第2引数は付ける名前。
# 返り値: 0=付けた / 1=見送り（宛先も名前も無い）/ 2=付けられなかった。
# 1・2のときは理由を標準出力へ1行で返す。
#
# **呼び出し元を止めない。** 名前が付かなくてもセッションは動き、`codex queue`の宛先はUUIDの
# ままなので、失敗しても報告以上のことはしない。
codex_thread_name_set() {
  local thread="$1" name="$2" attempt=1 out status

  if [[ -z "$thread" ]]; then
    echo "Codexのセッションの宛先（スレッドUUID）がまだ分かりません"
    return 1
  fi
  if [[ -z "$name" ]]; then
    echo "付ける名前が空です"
    return 1
  fi
  if ! command -v "$CODEX_THREAD_NAME_COMMAND" >/dev/null 2>&1; then
    echo "$CODEX_THREAD_NAME_COMMAND コマンドが見つからないため名前を付けられませんでした"
    return 2
  fi

  while ((attempt <= CODEX_THREAD_NAME_ATTEMPTS)); do
    status=0
    out="$(codex_thread_name_call "$thread" "$name")" || status=$?
    case "$status" in
      0) return 0 ;;
      3)
        ((attempt == CODEX_THREAD_NAME_ATTEMPTS)) && break
        sleep "$CODEX_THREAD_NAME_RETRY_SECONDS"
        ;;
      *) break ;;
    esac
    ((attempt++))
  done

  echo "${out:-名前を付けられませんでした}"
  return 2
}

# ---------------------------------------------------------------------------
# 付けた名前は、モデルの自動命名で上書きされる（#3220）
#
# #2540では「モデルの自動命名に上書きされない」としていたが、**実機（codex-cli 0.152.1）では
# 逆だった。** `SessionStart`で付けた`<リポジトリ名> #<番号>`は、最初のターンの2〜6秒後に
# モデルが付け直す題名で消える。索引（`~/.codex/session_index.jsonl`）には3行がこの順で並ぶ。
#
#   13:52:04  出力言語は日本語です。ユーザーの目に…  ← プロンプトの先頭を切ったもの
#   13:52:05  asset-manager #504                  ← `SessionStart`のフックが付けたもの
#   13:52:07  アプリアイコンを変更                  ← モデルの自動命名（これが残る）
#
# 2026-09-20時点でapp-serverの一覧に出ていた25本のうち22本が自動命名のままで、**ChatGPT
# アプリのリモート制御からどれがどのIssueのセッションか選べなかった**（#2524・#2537で繋がるのは
# ホスト単位＝そのホストのCodexセッション全部の一覧なので、見分ける手段は名前しかない）。
#
# **自動命名を止める設定は無い**（`codex features list`にも索引・`config.toml`のキーにも
# 見当たらない）ため、pollerの巡回から付け直す。自動命名が走るのは最初のターンの1回だけなので、
# 付け直しも実質1回で落ち着く。
# ---------------------------------------------------------------------------

# 付け直しそのものを止めるスイッチ（0で無効）。**壊れたときに黙って止められる逃げ道**で、
# `lib/session-codex-step.sh`の`ISSUE_DECK_CODEX_STEP`と同じ持たせ方。
CODEX_THREAD_NAME_SYNC_ENABLED="${ISSUE_DECK_CODEX_NAME_SYNC:-1}"

# Codexの索引。**`CODEX_HOME`を尊重する**（`codex`自身が見る場所と揃える）。
CODEX_THREAD_NAME_INDEX="${ISSUE_DECK_CODEX_SESSION_INDEX:-${CODEX_HOME:-$HOME/.codex}/session_index.jsonl}"

# いま付いている名前を返す。**読めないときは非0**（＝何もしない側へ倒す）。
#
# 索引は`{"id":"<UUID>","thread_name":"…","updated_at":"…"}`の追記型で、**名前が変わるたびに
# 1行増える**。同じIDの行が複数あるので、最後の行が現在の名前になる。
#
# **形はCodexの内部仕様**（公開されていない）。読めない・知らない形のときは名前を触らない
# ——付け直しを諦めれば自動命名のままになるだけだが、当て推量で書くと人が付けた名前も壊す。
codex_thread_name_current() {
  local thread="$1" line name
  [[ -n "$thread" ]] || return 1
  [[ -f "$CODEX_THREAD_NAME_INDEX" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1

  # **UUIDで絞ってから最後の1行だけを解く。** 索引は1日に数十行ずつ伸びるので、
  # 全行をjqへ流すとセッションの数だけ読み直すことになる。
  line="$(grep -F -- "$thread" "$CODEX_THREAD_NAME_INDEX" 2>/dev/null | tail -n 1)"
  [[ -n "$line" ]] || return 1
  name="$(jq -r --arg id "$thread" 'select(.id == $id) | .thread_name // empty' <<<"$line" 2>/dev/null)"
  [[ -n "$name" ]] || return 1
  printf '%s' "$name"
}

# 名前が`<リポジトリ名> #<番号>`からずれていたら付け直す。
#
# 第1引数はスレッドUUID、第2引数は付けたい名前。
# 返り値: 0=揃っている／付け直した / 1=見送り（宛先・名前が無い、索引を読めない）/ 2=付け直せなかった。
#
# **判定で`codex`を起こさない。** 索引を読むだけなので、巡回のたびに呼んでよい。実際に
# `codex app-server`を起こすのはずれているときだけで、付け直した結果も索引へ1行入るため、
# 次の巡回では何も起きない。
codex_thread_name_sync() {
  local thread="$1" name="$2" current

  [[ "$CODEX_THREAD_NAME_SYNC_ENABLED" == "1" ]] || return 1
  if [[ -z "$thread" || -z "$name" ]]; then
    echo "付け直す宛先または名前がありません"
    return 1
  fi

  current="$(codex_thread_name_current "$thread" 2>/dev/null || true)"
  if [[ -z "$current" ]]; then
    echo "Codexの索引から今の名前を読めませんでした"
    return 1
  fi
  [[ "$current" == "$name" ]] && return 0

  codex_thread_name_set "$thread" "$name"
}
