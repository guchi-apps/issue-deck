#!/usr/bin/env bash
# 別のAIへ引き継ぐときの「引き継ぎ要約」を書き出す共有処理（#3496）。
#
# 使うのは`scripts/subpc-dispatch-poller.sh`だけ。画面の「別のAIで続ける」で積まれた起動ジョブ
# （`handoffFrom`付きのLAUNCH）を受けたとき、**元セッションを止める前に**これを呼び、書いた
# ファイルのパスを`ISSUE_DECK_HANDOFF_FILE`として`start-issue.sh`へ渡す。`start-issue.sh`は
# その中身を、新しいセッションの最初の指示の末尾へ追記する。
#
# **要約はLLMを呼ばずに機械的に作る。** 材料は元セッションの転記の末尾（やり取りの抜粋）と、
# ブランチの状態（コミット・未コミットの変更）だけ。整理は、引き継ぎ先のセッション自身が
# 抜粋を読んで行う（追加の枠を使わず、要約の誤りで作業が変な方向へ進むのも避ける）。
# Issue本文・コメント・承認済みの計画は起動プロンプト側にすでに入っているので、ここでは重ねない。
#
# **転記の場所は`lib/session-transcript.sh`が持つ**（転記を読むのは限られた場所だけにする決まり。
# docs/multi-agent/session-inspect.md）。ここはその関数で引いたファイルの**末尾だけ**を読み、
# 引けない・読めないときは「転記を取得できませんでした」と書いて続ける（要約が作れないことで
# 引き継ぎそのものを止めない）。転記の形式は公開仕様ではないため、壊れたら黙って諦める側へ倒す。
#
# このファイルは実行せず、sourceして使う。呼び出し元が`session-transcript.sh`と
# `session-state.sh`をsource済みであること。

# 抜粋に含めるやり取りの数（末尾から）と、1件・全体の長さの上限（文字数）。
# 長い転記をそのまま渡すと引き継ぎ先の枠を食うため、既定は控えめにしてある。
SESSION_HANDOFF_TURNS="${SESSION_HANDOFF_TURNS:-30}"
SESSION_HANDOFF_TURN_CHARS="${SESSION_HANDOFF_TURN_CHARS:-1500}"
SESSION_HANDOFF_TOTAL_CHARS="${SESSION_HANDOFF_TOTAL_CHARS:-30000}"

# 転記（JSONL）の末尾から、人とAIのやり取りだけを取り出して整形する。
#   $1 転記ファイル / $2 エージェント（claude / codex）
# 標準出力へ`[user]`・`[assistant]`の見出し付きで出す。読めなければ何も出さず0で返る。
#
# ツールの呼び出し・結果・システム注記（`<system-reminder>`等）は落とす。**残すのは人とAIの
# 文章だけ**にしないと、抜粋がツールの出力で埋まって何の作業かが読めなくなる。
session_handoff_extract_turns() {
  local transcript="$1" agent="$2"
  [[ -f "$transcript" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  # 行の途中で切れた最初の1行は`fromjson?`が捨てる。全件を読まず末尾だけ見るので、数十MBの転記でも遅くならない。
  # 長さの上限は「新しい方から詰めて、超える分は捨てる」（古いやり取りより直近を残す）。
  tail -n 4000 "$transcript" 2>/dev/null \
    | jq -R -s -r \
      --arg agent "$agent" \
      --argjson turns "$SESSION_HANDOFF_TURNS" \
      --argjson each "$SESSION_HANDOFF_TURN_CHARS" \
      --argjson total "$SESSION_HANDOFF_TOTAL_CHARS" '
        def turn:
          if $agent == "codex" then
            select(.type == "response_item" and .payload.type == "message"
              and (.payload.role == "user" or .payload.role == "assistant"))
            | {role: .payload.role, text: ([.payload.content[]? | .text // empty] | join("\n"))}
          else
            select((.type == "user" or .type == "assistant") and ((.isSidechain // false) | not))
            | {role: .type, text: (.message.content
                | if type == "string" then . else ([.[]? | select(.type == "text") | .text] | join("\n")) end)}
          end;
        [split("\n")[] | fromjson? | turn
          | select(.text != "" and (.text | test("^\\s*<(system-reminder|local-command|command-|user-prompt-submit-hook)") | not))
          | "[" + .role + "]\n"
            + (if (.text | length) > $each then .text[0:$each] + "\n…（長いため省略）" else .text end)]
        | .[-$turns:]
        | reduce (reverse[]) as $t ([];
            if ((map(length) | add // 0) + ($t | length)) > $total then . else . + [$t] end)
        | reverse
        | join("\n\n")' 2>/dev/null || true
}

# ブランチの状態（作業ディレクトリがあるときだけ）。
#   $1 作業ディレクトリ
session_handoff_git_state() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || return 0
  printf 'ブランチ: %s\n\n' "$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '不明')"
  printf 'origin/develop からのコミット:\n'
  git -C "$dir" log --oneline origin/develop..HEAD 2>/dev/null | head -20 | sed 's/^/- /'
  printf '\n未コミットの変更:\n'
  git -C "$dir" status --short 2>/dev/null | head -40 | sed 's/^/- /'
}

# 引き継ぎ要約を書き出す。
#   $1 引き継ぎ元のエージェント（claude / codex）
#   $2 元セッションのtmux名 / $3 作業ディレクトリ
#   $4 出力するMarkdownのパス
#   $5 生の転記も添えるか（1 / 0）
# 書けたら0、出力先を作れないときだけ非0。**転記が引けなくても0で返す**（その旨を要約へ書く）。
session_handoff_build() {
  local from_agent="$1" session="$2" worktree="$3" out="$4" include_transcript="${5:-0}"
  local transcript="" turns git_state copy=""

  mkdir -p "$(dirname "$out")" || return 1

  # 元がCodexのときの転記引きは、状態ファイル（スレッドUUID）に頼る。**元セッションを止める前に
  # 呼ぶ**のはそのため（止めた後は状態ファイルが消える）。
  transcript="$(session_transcript_path "$session" 2>/dev/null || true)"
  if [[ -n "$transcript" && ! -f "$transcript" ]]; then
    transcript=""
  fi

  if [[ -n "$transcript" ]]; then
    turns="$(session_handoff_extract_turns "$transcript" "$from_agent")"
  else
    turns=""
  fi
  git_state="$(session_handoff_git_state "$worktree")"

  if [[ "$include_transcript" == "1" && -n "$transcript" ]]; then
    copy="${out%.md}.transcript.jsonl"
    cp -f "$transcript" "$copy" 2>/dev/null || copy=""
  fi

  {
    printf '## 前のセッションからの引き継ぎ\n\n'
    printf 'このIssueは、別のAI（%s）のセッションで途中まで進められていました。%s\n\n' \
      "$from_agent" \
      '同じブランチ・同じ作業ディレクトリを引き継いでいます。下の抜粋とブランチの状態から現在地を把握し、続きから作業してください。'
    printf -- '- **承認と計画の確認**: 計画が承認済みかどうかは、Issueコメントで確かめてください。承認済みの計画があれば取り直さず、その計画に沿って実装を続けます。未承認なら、計画の提示から進めます。\n'
    printf -- '- **抜粋は要約ではありません**: 元セッションの末尾のやり取りを、そのまま（長いものは省略して）並べたものです。決定事項・未完了の作業・詰まっていた点を、読んで自分で整理してから動いてください。\n'
    printf -- '- 元のセッションは停止済みです。同じ作業を二重に進めないでください。\n\n'
    printf '### ブランチの状態\n\n'
    if [[ -n "$git_state" ]]; then
      printf '%s\n\n' "$git_state"
    else
      printf '（取得できませんでした）\n\n'
    fi
    printf '### 直近のやり取り（末尾 %s 件まで）\n\n' "$SESSION_HANDOFF_TURNS"
    if [[ -n "$turns" ]]; then
      printf '%s\n\n' "$turns"
    else
      printf '（転記を取得できませんでした。Issueコメントとブランチの状態から現在地を判断してください）\n\n'
    fi
    if [[ -n "$copy" ]]; then
      # shellcheck disable=SC2016  # バッククォートはMarkdownのコード表記で、展開させない
      printf '### 元セッションの転記（全文）\n\n必要なときだけ読んでください（長く、読むほど枠を使います）: `%s`\n' "$copy"
    fi
  } >"$out"
}

# 引き継ぎファイルの置き場。**ランチャー（契約適合の`start-issue.sh`・汎用の`generic-start-issue.sh`）の
# worktreeベースに依存しない固定の場所**にする（ランチャーごとに`WORKTREE_BASE`の既定が違うため）。
# pollerが書き、ランチャーが読む。両者がこの関数で同じパスを引く。
session_handoff_dir() {
  printf '%s' "${ISSUE_DECK_HANDOFF_DIR:-$HOME/.local/state/issue-deck/handoff}"
}

# リポジトリ名とIssue番号から、要約ファイルのパスを引く。
#   $1 リポジトリ名（ownerを含まない） / $2 Issue番号
session_handoff_file_path() {
  printf '%s/%s-issue-%s.md' "$(session_handoff_dir)" "$1" "$2"
}

# 古い引き継ぎファイル（要約・転記のコピー）を消す。書き出しのたびに呼ぶ。
# 転記のコピーは新しいセッションが後から読むことがあるため、起動直後には消さず日数で畳む。
session_handoff_prune() {
  local dir
  dir="$(session_handoff_dir)"
  [[ -d "$dir" ]] || return 0
  find "$dir" -maxdepth 1 -type f \( -name '*.md' -o -name '*.jsonl' \) -mtime +14 -delete 2>/dev/null || true
}

# 起動プロンプトの末尾へ、引き継ぎ要約を追記する。**ランチャーが呼ぶ。**
#   $1 プロンプトファイル / $2 リポジトリ名 / $3 Issue番号
#
# 追記するのは、`ISSUE_DECK_HANDOFF_FILE`が**このIssueの要約ファイルのパスと完全に一致**するときだけ。
# 環境変数が別のIssueの分・任意のパスを指していても読まない（複数Issueを1回で起動するときに、
# 前のIssueの要約が次のIssueへ漏れるのも防ぐ）。無い・一致しないときは何もしない＝通常の起動。
session_handoff_append_to_prompt() {
  local prompt_file="$1" repo="$2" issue="$3" expected
  [[ -n "${ISSUE_DECK_HANDOFF_FILE:-}" ]] || return 0
  expected="$(session_handoff_file_path "$repo" "$issue")"
  [[ "$ISSUE_DECK_HANDOFF_FILE" == "$expected" && -f "$expected" && -f "$prompt_file" ]] || return 0
  {
    printf '\n'
    cat "$expected"
  } >>"$prompt_file"
}
