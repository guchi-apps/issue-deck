#!/opt/homebrew/bin/bash
#
# Mac mini（macOS）でpoller・wake receiverを起動する薄いラッパー（#5528）。
#
# launchdにはsystemdの`EnvironmentFile=`に当たる仕組みが無いため、ここで
# `~/.config/issue-deck/dispatch.env`（`KEY=値`の形式・`export`無し）を読み込んでから
# 引数のコマンドへ`exec`する。読み込み方はsystemdと揃え、値をシェルとして評価しない
# （`$`やバッククォートを含む値もそのまま渡す）。
#
# PATHはplist側で、Homebrewの`bash`・GNU coreutils（gnubin）・util-linuxを
# 先頭にした値を渡す。スクリプト群がbash 4以降とGNU版のコマンドを前提にしているため。
set -euo pipefail

env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
if [[ ! -r "$env_file" ]]; then
  echo "設定ファイルが読めません: $env_file（deploy/macmini/README.md の手順で作成してください）" >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  # 空行・コメント行は飛ばす
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    # systemdと同じく、全体を囲む引用符だけは外す
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    export "$key=$value"
  fi
done < "$env_file"

if [[ $# -eq 0 ]]; then
  echo "使い方: $0 <コマンド> [引数...]" >&2
  exit 2
fi

# **PATHはここで並べ直す**（#5538）。plistで先頭に置いても、`bash -l`（ログインシェル）が
# `/etc/profile`経由で`path_helper`を走らせ、`/usr/bin:/bin`を先頭へ並べ替える。pollerの
# shebangは`#!/usr/bin/env bash`なので、そのままだとmacOS標準のbash 3.2が選ばれて
# `scripts/lib/os-compat.sh`の版チェックで止まる（launchdが30秒おきに起こし直し続ける）。
for dir in /opt/homebrew/bin /opt/homebrew/opt/util-linux/bin /opt/homebrew/opt/coreutils/libexec/gnubin; do
  [[ -d "$dir" ]] || continue
  PATH="$dir:${PATH//":$dir"/}"
  PATH="${PATH#"$dir:$dir:"}"
done
export PATH

exec "$@"
