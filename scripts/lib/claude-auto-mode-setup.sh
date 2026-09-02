#!/usr/bin/env bash
# `~/.claude/settings.json`の`permissions.defaultMode`を`auto`に揃える（#2733）。
#
# 誰が使うか:
#   scripts/start-issue.sh      実装セッションのランチャー
#   scripts/start-reviewer.sh   レビュー・統合セッションのランチャー
#
# ## なぜ要るか
#
# ローカルセッションは`--permission-mode auto`（#1205）というCLI引数付きで起動しているが、
# **CLI引数だけではauto modeへの同意状態が保たれない。** Claude Code本体には、
# `settings.json`側に`permissions.defaultMode: "auto"`が書かれていない状態だと、
# auto modeの同意（`skipAutoPermissionPrompt`）を打ち消すマイグレーションがある
# （v2.1.258で確認。`~/.claude.json`に`hasResetAutoModeOptInForDefaultOffer: true`が
# 立っていれば実行済み）。
#
# 打ち消されると、CLI引数で`auto`を渡していてもクラシファイアの自動承認が働かず、
# `grep`のような読み取り専用のコマンドまで1件ずつ承認を求められる（#2733で実測）。
# サブPCの無人に近い起動では誰も答えられないため、セッションが実質進まない。
#
# ## CLI引数ではなく設定ファイルに書く
#
# `--permission-mode auto`は起動ごとの指定で、上のマイグレーションの判定材料にならない。
# **判定が見るのは設定ファイルの値だけ**なので、ファイル側にも同じ意図を残す。
# 2つは矛盾しない（どちらも「既定はauto」）。
#
# ## 書き換える範囲を最小にする
#
# `permissions.defaultMode`の1キーだけを足し、他のキーには触らない。読み書きはpython3で行い、
# 既存の内容をそのまま保つ。**`bypassPermissions`のような危険な値は書かない**——ここが書くのは
# 常に`auto`で、値を外から受け取らない。
#
# ## 何もしない条件
#
#   - `ISSUE_DECK_SKIP_AUTO_MODE_SETUP=1`（明示的に止めたいとき）
#   - `ISSUE_DECK_CLAUDE_PERMISSION_MODE`が`auto`以外（人が別のモードを選んでいる。#1205）
#   - すでに`permissions.defaultMode`が何か設定されている（人の選択を上書きしない）
#   - python3が無い・設定ファイルが壊れている・書き込めない（fail open）
#
# fail openにする理由は`claude-trust.sh`と同じ。ここで誤って止めると、正常に起動できるはずの
# セッションが1つも立たなくなり、症状は元の不具合より重い。
#
# このファイル自体は実行せず、source して使う。

# `~/.claude/settings.json`の場所。`CLAUDE_CONFIG_DIR`を設定している環境ではその直下にある。
claude_auto_mode_settings_file() {
  if [[ -n "${CLAUDE_CONFIG_DIR:-}" ]]; then
    printf '%s/settings.json' "$CLAUDE_CONFIG_DIR"
    return 0
  fi
  printf '%s/.claude/settings.json' "$HOME"
}

# `permissions.defaultMode`が未設定なら`auto`を書く。
#
# 出力は「実際に書いたとき」だけ1行。毎回出すと起動ログが埋まるうえ、伝えたいのは
# 「設定が変わった」ことだけ。戻り値は常に0（呼び出し元は起動を続ける）。
ensure_claude_auto_mode_default() {
  local settings_file
  [[ "${ISSUE_DECK_SKIP_AUTO_MODE_SETUP:-0}" == "1" ]] && return 0
  # 人が`auto`以外を選んでいるときは触らない。`run-issue-session.sh`・`start-reviewer.sh`が
  # 既定を`auto`とするのと同じ変数を見る（未設定なら`auto`扱い）。
  [[ "${ISSUE_DECK_CLAUDE_PERMISSION_MODE:-auto}" == "auto" ]] || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  settings_file="$(claude_auto_mode_settings_file)"

  # 終了コード: 0=書いた / 1=何もしなかった（既に設定済み・判定不能・書けない）
  python3 - "$settings_file" <<'PY' && \
    echo "情報: $settings_file の permissions.defaultMode を auto にしました（auto modeの同意が打ち消されるのを防ぎます。#2733）"
import json
import os
import sys

path = sys.argv[1]

try:
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = {}
except Exception:
    # 壊れている・読めない。触らずに諦める（fail open）。
    sys.exit(1)

if not isinstance(data, dict):
    sys.exit(1)

permissions = data.get("permissions")
if permissions is None:
    permissions = {}
elif not isinstance(permissions, dict):
    # こちらの知っている書式ではない。触らない。
    sys.exit(1)

# **既に何か入っていれば上書きしない。** 人が選んだ値かもしれない。
if permissions.get("defaultMode") is not None:
    sys.exit(1)

permissions["defaultMode"] = "auto"
data["permissions"] = permissions

# 書き込みは一時ファイル経由。途中で落ちても元のファイルを壊さない。
tmp = path + ".issue-deck.tmp"
try:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except Exception:
        pass
    sys.exit(1)

sys.exit(0)
PY
  return 0
}
