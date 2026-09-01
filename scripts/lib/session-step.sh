#!/usr/bin/env bash
# セッションが「いま何をしているか」を表すステップ（#2705）。
#
# 画面はこれまでサブPCのセッションを「実行中」「作業中」の一語でしか表せず、テストで詰まって
# いるのか、まだ調べているだけなのかは`tmux attach`しないと分からなかった。**判定材料は
# Claude Codeのフックが渡してくる`tool_name`と`tool_input.command`だけ**で、画面
# （`capture-pane`）も転記も読まない——[docs/multi-agent/gates.md](../../docs/multi-agent/gates.md)の
# 「計器の担当範囲は『フックが飛ぶか』で切る」の内側に収める。
#
# **文言ではなくコードを返す。** `session_state_write_reap`の理由コードと同じ扱いで、画面に出す
# 言い方はissue-deck側（`src/lib/dispatch/issue-session.ts`）に1つだけ置く。ログと画面で同じ
# 状態が2通りの言い方になるのを避ける。
#
# **コマンドの原文は運ばない。** `pnpm ... --token=...`のような行がそのままDBと画面へ出るのを
# 避けるため、分類はここで済ませてコードだけを`.step`へ書く。
#
# **知らないツールでは何も返さない**（非0で返る）。書き換えないので直前のステップが残る。
# 当てずっぽうに「コマンド実行中」を書くと、MCPのツールやSkillの実行が全部そこへ落ちる。
#
# このファイル自体は実行せず、source して使う。

# 語彙。**issue-deck側の`SESSION_STEPS`（`src/lib/dispatch/session-state.ts`）と揃える。**
# 増やすときは両方に足す（片方だけだと、知らないコードとして画面側が落とす）。
# 読むのは`scripts/session-step.test.mjs`の突き合わせだけなので、shellcheckには未使用に見える。
# shellcheck disable=SC2034
SESSION_STEP_CODES=(
  PLANNING     # 計画作成中
  EXPLORING    # 調査中
  EDITING      # 実装中
  LINTING      # Lintチェック中
  TYPECHECKING # 型チェック中
  TESTING      # テスト中
  BUILDING     # ビルド中
  COMMITTING   # コミット中
  PUSHING      # push中
  PR           # PRを作成中
  ISSUE        # Issueへ記録中
  ARTIFACT     # アーティファクト公開中
  RUNNING      # コマンド実行中（上のどれにも当たらないBash）
)

# `Bash`のコマンドからステップコードを決める。
#
# **上から順に見て最初に当たったものを採る。** `cd … && pnpm lint`のような連結や、`pnpm run
# lint`の`run`を挟む形に当たるよう、コマンド名は前後の空白か行頭・行末で挟んで見る。
# 語の一部（`grep -n "lint"`の中の`lint`）に当たらないのはこのため。
#
# **書き込む操作を読み取りより先に見る。** `gh issue comment`と`gh issue view`は前半が同じで、
# 先に読み取り側を当てると記録の操作まで「調査中」になる。
session_step_from_bash_command() {
  local command="${1:-}"
  # 大文字小文字は無視する（`PNPM Lint`のような書き方でも同じに扱う）
  local lower="${command,,}"

  # 書き込む操作（GitHub）
  if [[ "$lower" =~ (^|[[:space:]])gh[[:space:]]+pr[[:space:]]+(create|edit|comment|merge|ready|close|reopen)([[:space:]]|$) ]]; then
    printf 'PR'
    return 0
  fi
  if [[ "$lower" =~ (^|[[:space:]])gh[[:space:]]+issue[[:space:]]+(create|edit|comment|close|reopen|develop)([[:space:]]|$) ]]; then
    printf 'ISSUE'
    return 0
  fi

  # 書き込む操作（git）。**pushをcommitより先に見る**——`git commit && git push`のように
  # 続けて打つことが多く、先にcommitへ倒すと出ている間ずっと「コミット中」になる
  if [[ "$lower" =~ (^|[[:space:]])git[[:space:]]+(.*[[:space:]])?push([[:space:]]|$) ]]; then
    printf 'PUSHING'
    return 0
  fi
  if [[ "$lower" =~ (^|[[:space:]])git[[:space:]]+(.*[[:space:]])?(commit|add)([[:space:]]|$) ]]; then
    printf 'COMMITTING'
    return 0
  fi

  # 検証。**型チェックをLintより先に見る**——`pnpm lint && pnpm typecheck`のような連結では
  # 先に当たった方が採られるが、時間が掛かるのは型チェック側で、そちらを出した方が実態に近い
  if [[ "$lower" =~ (^|[[:space:]])(pnpm|npm|npx|yarn|bun)([[:space:]]+run)?[[:space:]]+(typecheck|type-check|tsc)([[:space:]]|$) ]] ||
    [[ "$lower" =~ (^|[[:space:]])(tsc|mypy|pyright)([[:space:]]|$) ]]; then
    printf 'TYPECHECKING'
    return 0
  fi
  if [[ "$lower" =~ (^|[[:space:]])(pnpm|npm|npx|yarn|bun)([[:space:]]+run)?[[:space:]]+(lint|lint:fix|format)([[:space:]]|$) ]] ||
    [[ "$lower" =~ (^|[[:space:]])(eslint|prettier|biome|ruff|shellcheck)([[:space:]]|$) ]]; then
    printf 'LINTING'
    return 0
  fi
  if [[ "$lower" =~ (^|[[:space:]])(pnpm|npm|npx|yarn|bun)([[:space:]]+run)?[[:space:]]+test([[:space:]:]|$) ]] ||
    [[ "$lower" =~ (^|[[:space:]])(vitest|jest|pytest|playwright)([[:space:]]|$) ]]; then
    printf 'TESTING'
    return 0
  fi
  if [[ "$lower" =~ (^|[[:space:]])(pnpm|npm|npx|yarn|bun)([[:space:]]+run)?[[:space:]]+build([[:space:]]|$) ]] ||
    [[ "$lower" =~ (^|[[:space:]])(next|cargo|go|make)[[:space:]]+build([[:space:]]|$) ]]; then
    printf 'BUILDING'
    return 0
  fi

  # 読み取りだけの操作。ここに当たるものは`Read`・`Grep`と同じ「調査中」へ寄せる
  if [[ "$lower" =~ (^|[[:space:]])git[[:space:]]+(.*[[:space:]])?(log|diff|status|show|blame|branch)([[:space:]]|$) ]] ||
    [[ "$lower" =~ (^|[[:space:]])gh[[:space:]]+(issue|pr|run|api|search)[[:space:]] ]] ||
    [[ "$lower" =~ (^|[[:space:]])(cat|sed|grep|rg|ls|find|head|tail|wc|jq|awk|tree)([[:space:]]|$) ]]; then
    printf 'EXPLORING'
    return 0
  fi

  printf 'RUNNING'
  return 0
}

# ツール名（と`Bash`ならコマンド）からステップコードを決める。
# **決められないときは非0で返る**（呼び出し側は直前のステップをそのまま残す）。
session_step_classify() {
  local tool="${1:-}" command="${2:-}"
  case "$tool" in
    ExitPlanMode)
      printf 'PLANNING'
      ;;
    Edit | Write | MultiEdit | NotebookEdit)
      printf 'EDITING'
      ;;
    Read | Grep | Glob | WebFetch | WebSearch | Agent | Task | Explore)
      printf 'EXPLORING'
      ;;
    Artifact)
      printf 'ARTIFACT'
      ;;
    Bash | BashOutput)
      session_step_from_bash_command "$command"
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

# フックのJSONから`tool_name`を取り出す。無ければ非0で返る。
#
# **`python3`も`jq`も起こさない。** ここはツールの実行ごとに必ず通る場所で、プロセスを1つ
# 増やすだけの価値が無い（`record_codex_thread`が`session_id`を正規表現で拾っているのと同じ）。
session_step_hook_tool_name() {
  local json="${1:-}"
  [[ "$json" =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"([A-Za-z_][A-Za-z0-9_-]*)\" ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}

# フックのJSONから`tool_input.command`の**先頭だけ**を取り出す。無ければ非0で返る。
#
# **閉じ引用符まで読み切らない。** JSONのエスケープ（`\"`）を正しく畳もうとすると、長い
# ヒアドキュメントを含むコマンドで正規表現が重くなる。分類に要るのは先頭の数語だけなので、
# 最初の引用符までか400文字までのどちらか短い方で切る。
session_step_hook_command() {
  local json="${1:-}"
  [[ "$json" =~ \"command\"[[:space:]]*:[[:space:]]*\"([^\"]{0,400}) ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}
