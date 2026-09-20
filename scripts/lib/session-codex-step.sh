#!/usr/bin/env bash
# Codexのセッションが「いま何をしているか」を、転記から`.step`へ書く（#3213）。
#
# ## なぜ転記から拾うのか
#
# Claude Codeの`.step`（`lib/session-step.sh`）は、`Pre/PostToolUse`フックが渡す`tool_name`と
# `tool_input.command`から書いている。Codexは`SessionStart`と`Stop`しかフックを繋いでおらず
# （docs/multi-agent/codex.md「`PostToolUse`は繋がない」）、`.step`が一度も書かれない。
# その結果、一覧の添える字は進捗Statusの「計画検討中（サブPC）」のまま固定され、進捗バーの
# 調査／実装／検証のマスも動かなかった。
#
# フックを繋ぐ案は、Codexの`exec`ラッパーの下で`tool_name`／`tool_input`がどう渡るかを実機で
# 確かめられておらず、ツール呼び出しごとにプロセスを起こすことにもなる。**転記の形は実機の
# 転記で確かめられる**（下記）ので、こちらを採る。反映はpollerの巡回間隔（60秒）ぶん遅れる。
#
# ## 転記の形（2026-09-20・codex-cli 0.152.1の実物）
#
# ツール呼び出しは`type=response_item`・`payload.type=custom_tool_call`・`payload.name=exec`の
# 1レコードで、`payload.input`にJSのコードが入る。
#
#   const r = await tools.exec_command({"cmd":"pnpm lint","workdir":"…"});
#   const r = await Promise.all([tools.exec_command({cmd:"git status"}), …]);
#   const patch = "*** Begin Patch\n…"; await tools.apply_patch(patch);
#
# 拾うのは`tools.apply_patch(`（＝ファイルの書き換え）と`tools.exec_command(`の`cmd`だけで、
# **分類は`lib/session-step.sh`をそのまま使う**（Claude Codeと同じ言い方になる）。
# `tools.write_stdin(`（走っているコマンドへの入力・待ち）と`update_plan`は、作業の種類を
# 表さないので何も書かない＝直前のステップが残る。
#
# **コマンドの原文は運ばない**（`session-step.sh`と同じ）。ここで分類して、コードだけを書く。
#
# ## 読めないときは何もしない
#
# 転記の形はCodexの内部仕様で、公開されていない。**形が変わって読めなくなったら`.step`を
# 書かない＝従来どおり進捗Statusの文言に戻る**へ倒す。読む量は転記の末尾4MiBだけ。
#
# このファイル自体は実行せず、source して使う。`lib/session-state.sh`・`lib/session-step.sh`・
# `lib/session-transcript.sh`が先にsourceされている前提。

# この仕組みそのものを止めるスイッチ（0で無効）。
SESSION_CODEX_STEP_ENABLED="${SESSION_CODEX_STEP_ENABLED:-1}"
# 転記の末尾から読む量（バイト）。`apply_patch`のパッチが大きいと1レコードが数百KBになる。
SESSION_CODEX_STEP_TAIL_BYTES="${SESSION_CODEX_STEP_TAIL_BYTES:-4194304}"

# コマンド文字列から、Codex固有の呼び出し（ランチャー側のスクリプト）を先に見て、
# 当たらなければ`session_step_from_bash_command`へ渡す。**決められないときは非0で返る。**
#
# `submit-plan.sh`・`submit-question.sh`は画面の返事を待って止まるコマンドで、待っている間の
# 表示は計画・質問のパネルが担う。「コマンド実行中」と出すと人を待っていることが隠れるので
# 何も書かない。
session_codex_step_from_command() {
  local command="${1:-}"
  case "$command" in
    *submit-plan.sh* | *submit-question.sh*) return 1 ;;
    *codex-artifact.sh*)
      printf 'ARTIFACT'
      return 0
      ;;
  esac
  session_step_from_bash_command "$command"
}

# 転記の末尾から、直近のツール呼び出し（`custom_tool_call`）を1件取り出して1行のJSONで返す。
#   {"at": <epoch>, "patch": bool, "exec": bool, "web": bool, "cmd": string|null}
# 見つからない・読めないときは何も出さずに非0で返る。
session_codex_step_last_call() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  # `custom_tool_call_output`は`"custom_tool_call"`（閉じ引用符つき）に当たらない。本文中に
  # 同じ語が出るレコードは、下のjqの`select`（構造での判定）で落とす。
  tail -c "$SESSION_CODEX_STEP_TAIL_BYTES" "$path" 2>/dev/null |
    grep -a '"custom_tool_call"' |
    tail -n 8 |
    jq -Rc '
      fromjson?
      | select(.type == "response_item" and .payload.type == "custom_tool_call")
      | (.payload.input // "") as $i
      | {
          at: ((.timestamp // "") | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null),
          patch: ($i | contains("tools.apply_patch(")),
          exec: ($i | contains("tools.exec_command(")),
          web: ($i | test("tools\\.(web__run|view_image)\\(")),
          cmd: (
            [
              $i
              | try (
                  capture("\"?cmd\"?\\s*:\\s*(?<c>\"(?:[^\"\\\\]|\\\\.)*\")")
                  | .c | fromjson | .[0:400]
                ) catch empty
            ] | first // null
          )
        }
      | select(.at != null)
    ' 2>/dev/null |
    tail -n 1 |
    grep .
}

# 直近のツール呼び出しをステップコードへ分類して、`.step`へ書く。
#   $1 tmuxのセッション名
# Codexのセッションでなければ何もしない。書かなかった（読めない・分類できない・すでに反映済み）
# ときも0で返る——呼び出し側の巡回を止めない。
session_codex_step_sync() {
  local session="$1" path last at patch exec_call web cmd step previous previous_seen
  [[ "$SESSION_CODEX_STEP_ENABLED" == "1" ]] || return 0
  [[ -n "$session" ]] || return 0
  [[ "$(session_state_agent_kind "$session" 2>/dev/null || true)" == "codex" ]] || return 0

  path="$(session_transcript_path "$session" 2>/dev/null || true)"
  [[ -n "$path" ]] || return 0
  last="$(session_codex_step_last_call "$path" 2>/dev/null || true)"
  [[ -n "$last" ]] || return 0

  at="$(jq -r '.at' <<<"$last" 2>/dev/null || true)"
  [[ "$at" =~ ^[0-9]+$ ]] || return 0
  patch="$(jq -r '.patch' <<<"$last")"
  exec_call="$(jq -r '.exec' <<<"$last")"
  web="$(jq -r '.web' <<<"$last")"
  cmd="$(jq -r '.cmd // empty' <<<"$last")"

  step=""
  if [[ "$patch" == "true" ]]; then
    step="EDITING"
  elif [[ "$exec_call" == "true" ]]; then
    if [[ -n "$cmd" ]]; then
      step="$(session_codex_step_from_command "$cmd" 2>/dev/null || true)"
    else
      # `cmd`を読み取れない形（変数経由など）。実行していることだけは言える
      step="RUNNING"
    fi
  elif [[ "$web" == "true" ]]; then
    step="EXPLORING"
  fi
  [[ -n "$step" ]] || return 0

  # 反映済みなら書き直さない（同じ呼び出しを毎巡書いても時刻が変わらないだけで無駄）
  previous="$(session_state_read_step "$session" 2>/dev/null || true)"
  if [[ "$previous" =~ ^([0-9]+)[[:space:]]+([A-Z_]+)[[:space:]]+([0-9]+)$ ]]; then
    previous_seen="${BASH_REMATCH[3]}"
    if [[ "${BASH_REMATCH[2]}" == "$step" && "$previous_seen" -ge "$at" ]]; then
      return 0
    fi
    # 転記より新しい記録は上書きしない（時計が戻る・別経路が書いた場合）
    if [[ "$previous_seen" -gt "$at" ]]; then
      return 0
    fi
  fi

  session_state_write_step "$session" "$step" "$at" || true
  return 0
}
