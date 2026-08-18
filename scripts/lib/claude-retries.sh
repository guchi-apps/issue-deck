#!/usr/bin/env bash
# Claude Codeのリトライ上限を、この仕組みが起こすセッション全体で揃える（#1971）。
#
# Claude Codeはサーバー側の一時エラー（529 Overloaded・500など）を**既定10回**まで再試行し、
# 使い切ると `API Error: 529 Overloaded. ...` を表示して**そのturnを打ち切る**。打ち切られると
# `Stop`フックが飛ばないまま止まり、誰にも通知されない（そこを拾い直す仕組みは
# `scripts/subpc-dispatch-poller.sh`の`resume_interrupted_sessions`にあるが、**そもそも
# 打ち切られない方が安い**）。
#
# 2026-08-18 16:12〜16:37（UTC）には実装セッション6本と計画レビュー2本が同時に打ち切られた。
# 短い過負荷であれば、粘る回数を増やすだけで打ち切りそのものを避けられる。
#
# **15はClaude Code側の上限**で、これを超える値は既定で15へ丸められる（本体が警告を出す）。
# 未対応の版では未知の環境変数として無視されるだけなので、版を判定せずに渡す。
#
# 値を変えたいときは、呼び出し元より先に `CLAUDE_CODE_MAX_RETRIES` を設定しておけばそちらが勝つ。
#
# このファイル自体は実行せず、source して使う。

claude_export_max_retries() {
  export CLAUDE_CODE_MAX_RETRIES="${CLAUDE_CODE_MAX_RETRIES:-15}"
}
