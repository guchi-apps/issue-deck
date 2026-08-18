#!/usr/bin/env bash
# 実装セッションの転記（Claude Codeのセッションログ）の場所を引く共有処理（#1971）。
#
# 読む側は2つだけ。
#
#   scripts/inspect-session.sh        人が他セッションのやり取りを読むとき
#   scripts/subpc-dispatch-poller.sh  APIエラーで中断したセッションを見つけるとき（#1971）
#
# **転記を読むのはこの2つと `scripts/session-notify.sh` に留める**
# （docs/multi-agent/session-inspect.md）。ここに依存した判定を他の仕組みへ広げない。
#
# **転記の置き場所・ディレクトリ名の作り方・`~/.claude/sessions/<pid>.json` の形は、いずれも
# 公開仕様ではない。** 壊れたら黙って諦める側へ倒し（どの関数も非0で返るだけ）、呼び出し元は
# 「何もしない」を選べるようにしておくこと。#1971の自動再開は、ここが引けなければ**中断を
# 検知しない**＝これまでどおり止まったまま人を待つ、という形で退化する。
#
# このファイル自体は実行せず、source して使う。

# 転記の置き場。`CLAUDE_PROJECTS_DIR` は inspect-session.sh が以前から解釈している環境変数で、
# 検証時に別の置き場を指せるようにしてある。
session_transcript_projects_dir() {
  printf '%s' "${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
}

# 走っているClaude Codeが自分の素性を書き出すディレクトリ（`<pid>.json`）。
# `tmux` / `cwd` / `sessionId` / `bridgeSessionId` が入っており、tmuxのセッション名から
# 転記とRemote ControlのURLの両方を引ける唯一の手掛かり。
session_transcript_records_dir() {
  printf '%s' "${CLAUDE_SESSIONS_DIR:-$HOME/.claude/sessions}"
}

# `<pid>.json` から1つの値を取り出す。第1引数はtmuxのセッション名。
#
# **`.tmux` は `<セッション名>:@<window>.%<pane>` の形**なので、先頭の要素だけを突き合わせる。
# 同じ名前で立て直した場合に備えて、一致したファイルのうち一番新しいものを使う。
session_transcript_record_field() {
  local session="$1" key="$2" dir file newest="" value
  [[ -n "$session" && -n "$key" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  dir="$(session_transcript_records_dir)"
  [[ -d "$dir" ]] || return 1
  for file in "$dir"/*.json; do
    [[ -f "$file" ]] || continue
    jq -e --arg s "$session" '((.tmux // "") | split(":")[0]) == $s' "$file" >/dev/null 2>&1 || continue
    if [[ -z "$newest" || "$file" -nt "$newest" ]]; then
      newest="$file"
    fi
  done
  [[ -n "$newest" ]] || return 1
  value="$(jq -r --arg k "$key" '.[$k] // empty' "$newest" 2>/dev/null || true)"
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

# セッション名 → 作業ディレクトリ。
# 生きている間は tmux から取るのが確実。取れないときだけ worktree の規約から補う
# （`<repo>-issue-<n>` → ~/apps/<repo>-worktrees/issue-<n>）。
session_transcript_cwd() {
  local session="$1" path repo number
  path="$(tmux display-message -p -t "=$session:" '#{pane_current_path}' 2>/dev/null || true)"
  if [[ -n "$path" && -d "$path" ]]; then
    printf '%s' "$path"
    return 0
  fi
  if [[ "$session" =~ ^(.+)-issue-([0-9]+)$ ]]; then
    repo="${BASH_REMATCH[1]}"
    number="${BASH_REMATCH[2]}"
    path="$HOME/apps/${repo}-worktrees/issue-${number}"
    [[ -d "$path" ]] && printf '%s' "$path" && return 0
  fi
  return 1
}

# 作業ディレクトリ → 転記の置き場。ディレクトリ名は cwd の非英数字を `-` へ置換したもの。
# **これは公開仕様ではない**ので、外れたときは各ディレクトリの `cwd` フィールドと突き合わせる
# フォールバックへ落ちる（総当たりになるため既定にはしない）。
session_transcript_dir() {
  local cwd="$1" slug dir latest projects
  projects="$(session_transcript_projects_dir)"
  slug="$(printf '%s' "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')"
  if [[ -d "$projects/$slug" ]]; then
    printf '%s' "$projects/$slug"
    return 0
  fi
  command -v jq >/dev/null 2>&1 || return 1
  for dir in "$projects"/*/; do
    [[ -d "$dir" ]] || continue
    latest="$(session_transcript_latest "${dir%/}")" || continue
    [[ -n "$latest" ]] || continue
    if head -n 40 "$latest" 2>/dev/null | jq -r -R 'fromjson? // empty | .cwd // empty' 2>/dev/null | grep -qxF "$cwd"; then
      printf '%s' "${dir%/}"
      return 0
    fi
  done
  return 1
}

# 転記ディレクトリの中で一番新しい .jsonl。セッションを再開すると増えるため、mtime で選ぶ。
session_transcript_latest() {
  local dir="$1" newest="" f
  for f in "$dir"/*.jsonl; do
    [[ -f "$f" ]] || continue
    if [[ -z "$newest" || "$f" -nt "$newest" ]]; then
      newest="$f"
    fi
  done
  [[ -n "$newest" ]] || return 1
  printf '%s' "$newest"
}

# セッション名 → 転記ファイル。**まず `<pid>.json` の `sessionId` で名指しする。**
# 転記のファイル名はそのままsessionIdなので、当たれば「そのセッションのもの」だと確実に言える。
# 引けないとき（jqが無い・記録が消えた・古いClaude Code）だけ、cwd → 置き場 → mtimeが最新、
# という従来の手順へ落ちる。
session_transcript_path() {
  local session="$1" cwd session_id dir path
  [[ -n "$session" ]] || return 1

  cwd="$(session_transcript_record_field "$session" cwd 2>/dev/null || true)"
  [[ -n "$cwd" ]] || cwd="$(session_transcript_cwd "$session" 2>/dev/null || true)"
  [[ -n "$cwd" ]] || return 1

  dir="$(session_transcript_dir "$cwd" 2>/dev/null || true)"
  [[ -n "$dir" ]] || return 1

  session_id="$(session_transcript_record_field "$session" sessionId 2>/dev/null || true)"
  if [[ "$session_id" =~ ^[A-Za-z0-9-]+$ ]]; then
    path="$dir/$session_id.jsonl"
    if [[ -f "$path" ]]; then
      printf '%s' "$path"
      return 0
    fi
  fi

  session_transcript_latest "$dir"
}

# セッション名 → Remote ControlのURL（best-effort）。
# `--remote-control` を付けずに起動した場合は `bridgeSessionId` が無く、URLも取れない。
session_transcript_remote_control_url() {
  local session="$1" bridge
  bridge="$(session_transcript_record_field "$session" bridgeSessionId 2>/dev/null || true)"
  [[ "$bridge" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  printf 'https://claude.ai/code/%s' "$bridge"
}
