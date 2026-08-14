#!/usr/bin/env bash
# セッションの出力言語を日本語に固定する（#1395）。
#
# scripts/run-issue-session.sh と scripts/start-reviewer.sh の両方から source する。
# このファイル自体は実行せず、source して使う。
#
# ## なぜ起動フラグで渡すか
#
# 「日本語で書く」という指示は、これまでコミットメッセージ・PR・Issueコメントといった**成果物**に
# ついてしかプロンプトへ書かれていなかった。エージェントの応答本文・提示する計画・TODO・ツール
# 実行時の説明といった「画面に出る文章」を日本語にしていたのは、個人設定（`~/.claude/CLAUDE.md`。
# 実体は guchi-apps/claude-config のsymlink）の1行だけで、次の穴があった。
#
# - メインPC・サブPCで同期が遅れていると効かない（lib/personal-config-sync.sh は警告するだけ）
# - リポジトリ側の規約として保証が無く、対象リポジトリのCLAUDE.md次第になる
#
# サブPCのローカルセッションは、対象リポジトリを問わず run-issue-session.sh を通る（契約マーカーを
# 宣言しているリポジトリ以外は generic-start-issue.sh 経由で同じスクリプトを共有する。
# docs/multi-agent/generic-launcher.md）。ここでシステムプロンプトへ足せば、個人設定の同期状態にも
# 対象リポジトリにも依存せず効く。
#
# `--settings`（フックの注入）と同じく、**このスクリプトから起こしたセッションにだけ適用される**。
# 手元の対話セッションの挙動は変わらない。
#
# ## 止めないこと
#
# `--append-system-prompt` を解釈しないClaude Codeへ渡すと起動ごと失敗するため、`--help` に
# フラグがあるときだけ付ける。無ければ情報行を出して素通りする（プロンプト本文側にも同じ趣旨の
# 「## 出力言語」の節があり、そちらで受ける）。

# 出力言語の指示文。**プロンプト本文（scripts/prompts/・.github/prompts/ の「## 出力言語」）と
# 同じ内容を保つ。** 片方だけ変えると、経路によって指示が食い違う。
AGENT_LANGUAGE_SYSTEM_PROMPT="出力言語は日本語です。ユーザーの目に触れる文章はすべて日本語で書いてください。応答本文・作業の要約・TODO・提示する計画・ツール実行時の説明・コミットメッセージ・PRのタイトルと本文・Issueコメントを含みます。コード・識別子・ファイルパス・コマンド・設定値・ログやエラーメッセージの引用は原文（英語）のままで構いません。"

# 呼び出し側の CLAUDE_EXTRA_ARGS 配列へ `--append-system-prompt` を追記する。
# 第1引数はログの接頭辞（例: "#123: "）。省略可。戻り値は常に0（`set -e` で呼び出し側を落とさない）。
append_language_system_prompt() {
  local log_prefix="${1:-}"

  if ! claude --help 2>/dev/null | grep -q -- "--append-system-prompt"; then
    echo "${log_prefix}情報: このClaude Codeは --append-system-prompt に未対応のため、出力言語の指定はプロンプト本文のみで行います。" >&2
    return 0
  fi

  CLAUDE_EXTRA_ARGS+=(--append-system-prompt "$AGENT_LANGUAGE_SYSTEM_PROMPT")
  return 0
}
