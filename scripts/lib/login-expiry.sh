#!/usr/bin/env bash
# サブPCのClaude Codeのログイン（OAuth）切れの検知（#5320）。
#
# ## 何が起きていたか
#
# ログインが切れると、API呼び出しは`Login reached its time limit · Please run /login`で止まる。
# 2026-11-11には、切れたまま無人で3セッションが起動され、それぞれ起動から数秒で止まった。
# 通知は無く、人が気付くまで最長約1時間かかった。`/login`は人がブラウザで認証する必要があり、
# 固定文面の再送（#1971）では直らない。
#
# ## どう判定するか
#
# **転記の末尾のレコードが`isApiErrorMessage: true`かつ`"error":"authentication_failed"`**
# （実物の転記で確かめた形。本文は`Login reached its time limit · Please run /login`）。
# 本文の文言（`Please run /login`）でも拾う。APIの一時エラー（529等）とは分けて判定する。
#
# **「ログインが直った」は資格情報ファイルの更新時刻で判定する。** `/login`は
# `~/.claude/.credentials.json`を書き直すので、その時刻より古いエラーは「直る前の失敗」として
# 数えない。止まったままのセッション（人が再開するまで転記の末尾がエラーのまま）が、ログインが
# 直ったあともホールドを続けさせない。状態を持たず毎巡この比較をするだけなので、取りこぼしても
# 次の巡で自然に解ける。
#
# 判定材料はClaude Codeの内部仕様なので、**読めなければ「切れていない」を返す**
# （起動を止める側に倒すと、判定が壊れただけでサブPCの起動が永久に止まる）。
#
# `lib/session-state.sh`と`lib/session-transcript.sh`が先にsourceされている前提。

# 切れを検知してからセッションが止まったとみなす最小の停滞秒数。エラー直後に続きを書き始める
# ことは無い（認証エラーは再試行されない）が、書き込みの途中を読まないための短い余裕。
LOGIN_EXPIRY_MIN_AGE_SECONDS="${LOGIN_EXPIRY_MIN_AGE_SECONDS:-30}"
LOGIN_EXPIRY_TAIL_BYTES="${LOGIN_EXPIRY_TAIL_BYTES:-65536}"

# 資格情報ファイル。検証では`CLAUDE_CREDENTIALS_FILE`で差し替えられる。
login_expiry_credentials_file() {
  printf '%s' "${CLAUDE_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
}

# 今のログインが書かれた時刻（資格情報ファイルのmtime）。読めなければ0。
login_expiry_credentials_mtime() {
  local file mtime
  file="$(login_expiry_credentials_file)"
  mtime="$(stat -c %Y "$file" 2>/dev/null || true)"
  [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=0
  printf '%s' "$mtime"
}

# 転記の末尾（会話のレコードの最後の1件）がログイン切れのエラーか。
login_expiry_transcript_auth_failed() {
  local transcript="$1" last
  [[ -f "$transcript" ]] || return 1
  last="$(tail -c "$LOGIN_EXPIRY_TAIL_BYTES" "$transcript" 2>/dev/null |
    grep -E '"type":"(assistant|user|queue-operation)"' | tail -1 || true)"
  [[ -n "$last" ]] || return 1
  printf '%s' "$last" | grep -q '"isApiErrorMessage":true' || return 1
  printf '%s' "$last" | grep -qE '"error":"authentication_failed"|Please run /login'
}

# そのセッションが、**今のログインより後に**ログイン切れで止まっているか。
login_expiry_session_expired() {
  local session="$1" transcript mtime now cred
  [[ -n "$session" ]] || return 1
  transcript="$(session_transcript_path "$session" 2>/dev/null || true)"
  [[ -n "$transcript" && -f "$transcript" ]] || return 1
  login_expiry_transcript_auth_failed "$transcript" || return 1
  mtime="$(stat -c %Y "$transcript" 2>/dev/null || true)"
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  ((now - mtime >= LOGIN_EXPIRY_MIN_AGE_SECONDS)) || return 1
  cred="$(login_expiry_credentials_mtime)"
  ((mtime > cred))
}

# 実装セッション（`<repo>-issue-<n>`）を走査し、ログイン切れで止まっているものを集める。
# 結果は`LOGIN_EXPIRED_SESSIONS`（古い順の配列）へ入れる。**呼ぶたびに入れ直す。**
# 引数: tmuxのセッション名を1行ずつ渡す（標準入力）。
LOGIN_EXPIRED_SESSIONS=()
login_expiry_scan() {
  local session transcript mtime
  local -a found=()
  while IFS= read -r session; do
    [[ "$session" =~ ^(.+)-issue-([1-9][0-9]*)$ ]] || continue
    [[ "$(session_state_agent_kind "$session" 2>/dev/null || true)" == "codex" ]] && continue
    login_expiry_session_expired "$session" || continue
    transcript="$(session_transcript_path "$session" 2>/dev/null || true)"
    mtime="$(stat -c %Y "$transcript" 2>/dev/null || printf 0)"
    found+=("$mtime $session")
  done
  LOGIN_EXPIRED_SESSIONS=()
  while IFS= read -r session; do
    [[ -n "$session" ]] && LOGIN_EXPIRED_SESSIONS+=("${session#* }")
  done < <(printf '%s\n' "${found[@]}" | sort -n)
  return 0
}

# ホスト単位の通知済みの印。**1回のログイン切れにつき1回だけ**引き上げる。
login_expiry_state_file() {
  printf '%s' "${LOGIN_EXPIRY_STATE_FILE:-$(dirname "$(session_state_dir)")/login-expired}"
}

# 通知済みか。
login_expiry_notified() {
  [[ -f "$(login_expiry_state_file)" ]]
}

login_expiry_record_notified() {
  local file
  file="$(login_expiry_state_file)"
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 0
  date +%s >"$file" 2>/dev/null || true
}

# ログインが直った（止まっているセッションが無くなった）ので印を消す。
login_expiry_clear() {
  rm -f "$(login_expiry_state_file)" 2>/dev/null || true
}
