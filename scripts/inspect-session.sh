#!/usr/bin/env bash
# 走っている（または畳んだ）実装セッションのやり取りを、人が読める形に畳んで端末へ出す（#1477）。
#
# 使い方:
#   scripts/inspect-session.sh                      生きているセッションの一覧
#   scripts/inspect-session.sh 1473                 Issue番号で指定
#   scripts/inspect-session.sh dayspan-issue-222    tmuxセッション名で指定
#   scripts/inspect-session.sh 1473 -n 30           直近30件のやり取りを出す（既定10）
#   scripts/inspect-session.sh 1473 --with-tools    ツールの呼び出し・結果も混ぜる（既定は文章だけ）
#   scripts/inspect-session.sh 1473 --screen        画面（capture-pane）の末尾も出す
#   scripts/inspect-session.sh 1473 --raw           転記ファイルのパスだけを出す（他コマンドへ渡す用）
#
# 環境変数:
#   CLAUDE_PROJECTS_DIR   転記の置き場（既定は ~/.claude/projects）
#   INSPECT_TAIL_BYTES    転記の末尾何バイトを読むか（既定8MB）
#
# ## なぜ要るか
#
# 他セッションのやり取りを見る手段は前から在るが（`tmux attach`・転記ファイル・Remote Control）、
# **見えるものが違ううえに毎回組み立て直していた**。とくに転記ファイル
# （`~/.claude/projects/<スラッグ>/<sessionId>.jsonl`）は画面から流れて消えた分まで全量残っており
# 一番情報が多いのに、1セッションで1.5MBを超えるため素で読むには重い。ここはその解決と抽出だけを
# 決定的に行う。設計は docs/multi-agent/session-inspect.md。
#
# ## 作法
#
# **これは読み取り専用の道具で、役ではない**（docs/multi-agent/gates.md「なぜ実装監督エージェントを
# 立てないのか」）。常駐せず、人が叩いたときに1回読んで出すだけで、読んだ結果から何かを送ることは
# しない。**読んだ内容をもとに対象セッションへ指示を送らないこと**（CLAUDE.md「監視・計画レビューを
# 行う実行体の禁止事項」。実行体が判断して組み立てた文字列の`send-keys`は禁止で、人が書いた1行を
# 「追加指示を送る」で送るのだけが例外）。
#
# **出力は端末に留める。** 転記には実装中のコード・環境変数・トークンが映りうる。Issueコメント・
# PR本文・DBへ貼らない（`src/lib/dispatch/session-escalation.ts` が「画面の内容は載せない」と
# しているのと同じ理由）。
#
# **Claude Codeの内部仕様に依存している。** 転記の置き場所・ディレクトリ名の作り方・JSONLの形は
# 公開仕様ではない。したがって**壊れたら黙って諦める**側へ倒し、読めないことを人向けの文言で伝えて
# 終わる（`scripts/session-notify.sh` の `resolve_remote_url` と同じ扱い）。

set -euo pipefail

CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
# 長いセッションでは数MBになるため全部は読まない（session-notify.sh の TRANSCRIPT_TAIL_BYTES と同じ考え方）。
INSPECT_TAIL_BYTES="${INSPECT_TAIL_BYTES:-8388608}"
# 1行が長すぎると読めないので切る。**バイトではなく文字数で切る**（日本語が途中で割れるため）。
LINE_WIDTH=180
# ツール集計で見る直近のツール使用の件数。
TOOL_TAIL=200
# --screen で出す画面の行数。
SCREEN_LINES=30

COUNT=10
SHOW_SCREEN=0
RAW_ONLY=0
WITH_TOOLS=0
TARGET=""

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

# 使い方はファイル冒頭のコメントを正とし、`## なぜ要るか`の手前までをそのまま出す
# （説明を2か所に持つと必ず片方が古くなる）。
usage() {
  awk 'NR == 1 { next } /^# ## / { exit } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while (($#)); do
  case "$1" in
    -n | --count)
      [[ ${2:-} =~ ^[0-9]+$ ]] || die "-n には件数を渡してください"
      COUNT="$2"
      shift 2
      ;;
    --screen)
      SHOW_SCREEN=1
      shift
      ;;
    --with-tools)
      WITH_TOOLS=1
      shift
      ;;
    --raw)
      RAW_ONLY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      die "不明なオプション: $1（--help で使い方を出せます）"
      ;;
    *)
      [[ -z "$TARGET" ]] || die "対象は1つだけ指定してください（$TARGET と $1）"
      TARGET="$1"
      shift
      ;;
  esac
done

command -v jq >/dev/null 2>&1 || die "jq がありません。転記の整形に必要です"
command -v tmux >/dev/null 2>&1 || die "tmux がありません"

# ---------------------------------------------------------------------------
# セッションの解決
# ---------------------------------------------------------------------------

# tmuxのセッション一覧。tmuxサーバーが立っていない場合は空を返す（エラーにしない）。
list_sessions() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null || true
}

# セッションが生きているか（ペインが死んでいないか）。
# **`pane_dead` だけで異常終了とは判断しない**（docs/multi-agent/gates.md）。ここは表示のみ。
session_state() {
  local session="$1" dead
  dead="$(tmux display-message -p -t "=$session:" '#{pane_dead}' 2>/dev/null || true)"
  case "$dead" in
    0) printf 'ALIVE' ;;
    1) printf 'EXITED' ;;
    *) printf 'UNKNOWN' ;;
  esac
}

# Issue番号 → セッション名。**複数当たったら選ばずに落とす。**
# リポジトリ違いで同じ番号があり得るため、黙って片方を掴むと別のセッションの中身を見せてしまう。
resolve_session_by_issue() {
  local number="$1" matches
  matches="$(list_sessions | grep -E -- "-issue-${number}\$" || true)"
  [[ -n "$matches" ]] || die "Issue #${number} のセッションが見つかりません（tmuxに立っていない、または既に畳まれています）"
  if [[ $(printf '%s\n' "$matches" | wc -l) -gt 1 ]]; then
    printf 'Issue #%s に複数のセッションが当たりました。セッション名で指定してください:\n' "$number" >&2
    printf '  %s\n' $matches >&2
    exit 1
  fi
  printf '%s' "$matches"
}

# セッション名 → 作業ディレクトリ。
# 生きている間は tmux から取るのが確実。取れないときだけ worktree の規約から補う
# （`<repo>-issue-<n>` → ~/apps/<repo>-worktrees/issue-<n>）。
resolve_session_cwd() {
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
resolve_transcript_dir() {
  local cwd="$1" slug dir latest
  slug="$(printf '%s' "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')"
  if [[ -d "$CLAUDE_PROJECTS_DIR/$slug" ]]; then
    printf '%s' "$CLAUDE_PROJECTS_DIR/$slug"
    return 0
  fi
  for dir in "$CLAUDE_PROJECTS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    latest="$(latest_transcript "${dir%/}")" || continue
    [[ -n "$latest" ]] || continue
    if head -n 40 "$latest" 2>/dev/null | jq -r -R 'fromjson? // empty | .cwd // empty' 2>/dev/null | grep -qxF "$cwd"; then
      printf '%s' "${dir%/}"
      return 0
    fi
  done
  return 1
}

# 転記ディレクトリの中で一番新しい .jsonl。セッションを再開すると増えるため、mtime で選ぶ。
latest_transcript() {
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

# ---------------------------------------------------------------------------
# 一覧（引数なし）
# ---------------------------------------------------------------------------

if [[ -z "$TARGET" ]]; then
  sessions="$(list_sessions)"
  if [[ -z "$sessions" ]]; then
    printf 'tmuxセッションはありません。\n'
    exit 0
  fi
  # 見出しは全角を含むため`%-32s`（バイト数で数える）では揃わない。空白を直接置いて合わせる。
  printf '%s\n' 'セッション                       状態     作業ディレクトリ'
  while IFS= read -r s; do
    [[ -n "$s" ]] || continue
    cwd="$(resolve_session_cwd "$s" || true)"
    printf '%-32s %-8s %s\n' "$s" "$(session_state "$s")" "${cwd:-(不明)}"
  done <<<"$sessions"
  printf '\n中身を見るには: %s <Issue番号|セッション名>\n' "${BASH_SOURCE[0]}"
  exit 0
fi

# ---------------------------------------------------------------------------
# 対象1つの表示
# ---------------------------------------------------------------------------

if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  SESSION="$(resolve_session_by_issue "$TARGET")"
else
  SESSION="$TARGET"
fi

[[ -d "$CLAUDE_PROJECTS_DIR" ]] ||
  die "転記の置き場がありません: $CLAUDE_PROJECTS_DIR（このホストでClaude Codeが動いていない可能性があります）"

CWD="$(resolve_session_cwd "$SESSION" || true)"
[[ -n "$CWD" ]] || die "セッション「$SESSION」の作業ディレクトリを特定できません（tmuxに無く、worktreeの規約にも当てはまりません）"

TRANSCRIPT_DIR="$(resolve_transcript_dir "$CWD" || true)"
[[ -n "$TRANSCRIPT_DIR" ]] || die "「$CWD」に対応する転記が $CLAUDE_PROJECTS_DIR にありません"

TRANSCRIPT="$(latest_transcript "$TRANSCRIPT_DIR" || true)"
[[ -n "$TRANSCRIPT" ]] || die "転記ファイル（.jsonl）が $TRANSCRIPT_DIR にありません"

if ((RAW_ONLY)); then
  printf '%s\n' "$TRANSCRIPT"
  exit 0
fi

# 自分自身を指した場合の警告。読んだ内容がそのまま自分の文脈へ入り、際限なく膨らむ。
SELF_SESSION="${TMUX:+$(tmux display-message -p '#{session_name}' 2>/dev/null || true)}"
if [[ -n "$SELF_SESSION" && "$SELF_SESSION" == "$SESSION" ]]; then
  printf '⚠ これは自分自身のセッションです。自分の転記を読み込むと文脈が二重になります。\n\n' >&2
fi

# 末尾だけを読み、パースできない行は捨てる。
# 途中から読み始めた1行目は必ず壊れているので落とす（ファイルが閾値未満なら落とさない）。
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
SIZE="$(stat -c %s "$TRANSCRIPT" 2>/dev/null || echo 0)"
if ((SIZE > INSPECT_TAIL_BYTES)); then
  tail -c "$INSPECT_TAIL_BYTES" "$TRANSCRIPT" | tail -n +2 | jq -R 'fromjson? // empty' >"$TMP" || true
else
  jq -R 'fromjson? // empty' <"$TRANSCRIPT" >"$TMP" || true
fi
[[ -s "$TMP" ]] || die "転記を読めませんでした: $TRANSCRIPT（形式が変わった可能性があります）"

meta_last() { jq -r --arg k "$1" 'select(.[$k] != null) | .[$k]' "$TMP" | tail -n 1; }

TITLE="$(jq -r 'select(.type=="custom-title") | .customTitle // empty' "$TMP" | tail -n 1)"
BRANCH="$(meta_last gitBranch)"
LAST_AT="$(meta_last timestamp)"
SIZE_MB="$(awk -v s="$SIZE" 'BEGIN { printf "%.1f", s / 1048576 }')"

printf 'セッション: %s (%s)%s\n' "$SESSION" "$(session_state "$SESSION")" "${TITLE:+  — $TITLE}"
printf '作業ディレクトリ: %s\n' "$CWD"
printf 'ブランチ: %s\n' "${BRANCH:-(不明)}"
printf '転記: %s (%sMB)\n' "$TRANSCRIPT" "$SIZE_MB"
printf '最終更新: %s\n' "${LAST_AT:-(不明)}"
printf '\n※ この内容はIssueコメント・PR本文・DBへ貼らないでください（コードや環境変数が映りえます）\n'

printf '\n--- 直近のやり取り (%s件) ---\n' "$COUNT"
# **既定ではツールの呼び出し・結果だけの行を捨てる。** 転記の大半はツールのやり取りで、混ぜると
# 「何をしているか」を表す文章が流れて見えなくなる（ツールの流れは下の集計で足りる）。
jq -r --argjson width "$LINE_WIDTH" --argjson withTools "$WITH_TOOLS" '
  select(.type == "user" or .type == "assistant")
  | (.message.content // null) as $c
  | (
      if ($c | type) == "string" then $c
      elif ($c | type) == "array" then
        [ $c[]
          | if .type == "text" then (.text // "")
            elif .type == "thinking" then (if $withTools == 1 then "[思考]" else "" end)
            elif .type == "tool_use" then (if $withTools == 1 then "[tool: " + (.name // "?") + "]" else "" end)
            elif .type == "tool_result" then (if $withTools == 1 then "[tool結果]" else "" end)
            else "" end
        ] | map(select(. != "")) | join(" ")
      else "" end
    ) as $raw
  | ($raw | gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "")) as $text
  | select($text != "")
  | ((.timestamp // "")[11:19]) as $at
  | (if .type == "user" then "user  " else "claude" end) as $who
  | $at + " [" + $who + "] " + (if ($text | length) > $width then ($text[0:$width] + "…") else $text end)
' "$TMP" | tail -n "$COUNT"

printf '\n--- 直近で使ったツール (直近%s件の内訳) ---\n' "$TOOL_TAIL"
tools="$(
  jq -r '
    select(.type == "assistant")
    | (.message.content // [])
    | if type == "array" then .[] else empty end
    | select(.type == "tool_use")
    | .name // "?"
  ' "$TMP" | tail -n "$TOOL_TAIL" | sort | uniq -c | sort -rn |
    awk '{ printf "%s%s x%s", sep, $2, $1; sep = " / " } END { print "" }'
)"
printf '  %s\n' "${tools:-(なし)}"

if ((SHOW_SCREEN)); then
  printf '\n--- 画面の末尾 (%s行) ---\n' "$SCREEN_LINES"
  tmux capture-pane -p -t "=$SESSION:" 2>/dev/null | grep -v '^\s*$' | tail -n "$SCREEN_LINES" |
    sed 's/^/  /' || printf '  (取得できませんでした)\n'
fi
