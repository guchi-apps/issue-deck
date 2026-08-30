#!/usr/bin/env bash
# Codexのセッションへ追加指示を差し込む（#2519）。
#
# `codex queue --thread <セッションUUID> --message '<本文>'`は、tmuxの中で走っている
# CodexのTUIセッションへ**別のシェルから**メッセージを積む。#2510の実機検証で分かっていること:
#
#   - **デーモンは要らない。** `codex agents`・`codex remote-control`と違い、app-serverの
#     デーモンが上がっていなくても動く（#2521でstandalone installへ入れ替える前から動いていた）
#   - **届き方は割り込みではなく次のターンの頭。** 走っているターンは最後まで流れ切る。
#     アイドル中のセッションへ投げると、その場で新しいターンが始まる
#   - 終了済み・存在しないセッションを指すと`Error: No active session found matching '<指定>'.`で
#     終了する（終了コードは0ではない）
#   - 投げたシェルのカレントディレクトリは関係ない
#
# **これがClaude Code側の3段階プロトコル（#1012）と決定的に違う点。** あちらは`send-keys`で
# TUIの入力欄へ文字を打ち込むため、選択フォーム・承認プロンプトの表示中に送ると勝手に回答済みに
# なる事故が起きうる（[docs/multi-agent/gates.md](../../docs/multi-agent/gates.md)が`send-keys`
# そのものを禁じ、そこだけを例外として開けている理由）。`codex queue`はキー入力を経由しないので、
# **その例外を開けずに同じことができる**。したがってここには画面（`capture-pane`）を読む処理も、
# 状態ファイルで送ってよいかを判定する処理も無い。
#
# このファイル自体は実行せず、source して使う。宛先（セッションUUID）の置き場は
# `lib/session-state.sh`の`.codex-thread`で、書くのは`session-notify.sh`の`SessionStart`。

# 実行する`codex`。**差し替えられるのは検証のときだけ**で、pollerは既定のまま使う。
CODEX_QUEUE_COMMAND="${ISSUE_DECK_CODEX_COMMAND:-codex}"

# `codex queue`の打ち切り（秒）。**待たされ続けないための保険。** 通常は即座に返る
# （メッセージを積むだけで、ターンの完了は待たない）。
CODEX_QUEUE_TIMEOUT_SECONDS="${ISSUE_DECK_CODEX_QUEUE_TIMEOUT_SECONDS:-30}"

# 追加指示を1件送る。
#
# 第1引数は宛先のセッションUUID、第2引数は本文。
# 返り値: 0=送った / 1=見送り（宛先がまだ分からない）/ 2=送れなかった（異常）。
# 1・2のときは理由を標準出力へ1行で返す（**呼び出し元が報告の形を決める**。
# `deliver_session_instruction`と同じ規約）。
codex_queue_send() {
  local thread="$1" body="$2" out status=0

  # **宛先が無いのは「見送り」。** ディレクトリの信頼確認（`Do you trust the contents of this
  # directory?`）に答えるまでフックが1つも飛ばず、UUIDが手に入らない。異常ではなく、
  # 人が答えれば送れるようになる状態なので、失敗として扱わない。
  if [[ -z "$thread" ]]; then
    echo "Codexのセッションの宛先（スレッドUUID）がまだ分かりません。ディレクトリの信頼確認に答えると送れるようになります"
    return 1
  fi
  if [[ -z "$body" ]]; then
    echo "追加指示の本文が空です"
    return 2
  fi
  if ! command -v "$CODEX_QUEUE_COMMAND" >/dev/null 2>&1; then
    echo "$CODEX_QUEUE_COMMAND コマンドが見つからないため送れませんでした"
    return 2
  fi

  # **本文は`--message`の値として1引数で渡す。** シェルの引用に頼らず配列で実行するので、
  # 本文にどんな文字が入っていてもコマンドとして解釈されない。
  #
  # **終了コードは`||`で受ける。** `if ! cmd; then $?` は`!`が反転させた後の値になり、
  # 打ち切り（124）と通常の失敗を見分けられない。
  out="$(timeout "$CODEX_QUEUE_TIMEOUT_SECONDS" \
    "$CODEX_QUEUE_COMMAND" queue --thread "$thread" --message "$body" 2>&1)" || status=$?
  if ((status != 0)); then
    # 打ち切りと、終了済みセッション（`No active session found matching …`）を同じ形で返す。
    # **理由はジョブの`message`として画面に出る**ので、原因の1行をそのまま載せる。
    if ((status == 124)); then
      echo "codex queue が ${CODEX_QUEUE_TIMEOUT_SECONDS} 秒で応答しなかったため打ち切りました"
      return 2
    fi
    echo "codex queue に失敗しました: $(codex_queue_last_line "$out")"
    return 2
  fi

  return 0
}

# 出力の最後の非空行を1行で返す（改行・復帰は落とす）。ジョブの`message`は1行なので、
# **複数行の出力をそのまま載せない**。
codex_queue_last_line() {
  printf '%s' "$1" | tr -d '\r' | grep -v '^[[:space:]]*$' | tail -1
}
