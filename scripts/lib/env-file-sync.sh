#!/usr/bin/env bash
# worktreeの環境変数ファイルを本体チェックアウトから供給・追従させる（#1099）。
#
# `scripts/start-issue.sh`（issue-deck自身）と`scripts/generic-start-issue.sh`（汎用ランチャー・
# #1224）が共有する。**片方だけが直ると、経路によって環境変数の揃い方が変わる。**
#
# worktreeの`.env.local`は作成時のコピーで固定されるため、本体に後から足した環境変数が既存の
# worktreeへ届かず、本体と違う挙動で画面確認をすることになっていた。既存キーの値には触れない
# （ローカルで書き換えている場合を壊さないため）。値はログに出さず、追記したキー名だけを表示する。
#
# **複製先（`~/.local/share/issue-deck/`）へは配らない。** 受け口はこのライブラリを使わない。

# 本体のenvファイルにあってworktree側に無いキーだけを、値ごと追記する。
#   $1 ログの見出しに使うラベル（Issue番号など）
#   $2 本体側のファイル
#   $3 worktree側のファイル
sync_missing_env_keys() {
  local label="$1"
  local source_file="$2"
  local target_file="$3"
  # 補完に失敗してもセッションの起動自体は妨げない（起動できない方が困るため）。
  local added
  if ! added="$(python3 - "$source_file" "$target_file" <<'PY'
import pathlib
import re
import sys

source_path = pathlib.Path(sys.argv[1])
target_path = pathlib.Path(sys.argv[2])

# PORTはworktreeごとに採番して別途書き込むため、同期の対象から外す。
EXCLUDED_KEYS = {"PORT"}

ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
# コメントアウトされた代入は「意図的に無効化している」とみなし、上書き復活させない。
COMMENTED_ASSIGNMENT = re.compile(r"^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")

source_lines = source_path.read_text(encoding="utf-8").splitlines()
target_text = target_path.read_text(encoding="utf-8")

existing = set()
for line in target_text.splitlines():
    matched = ASSIGNMENT.match(line) or COMMENTED_ASSIGNMENT.match(line)
    if matched:
        existing.add(matched.group(1))

added_keys = []
appended_lines = []
for i, line in enumerate(source_lines):
    matched = ASSIGNMENT.match(line)
    if not matched:
        continue
    key = matched.group(1)
    if key in EXCLUDED_KEYS or key in existing:
        continue
    # 何のためのキーかが分かるよう、直前の連続するコメント行も一緒に持っていく。
    start = i
    while start > 0 and source_lines[start - 1].lstrip().startswith("#"):
        start -= 1
    appended_lines.extend(source_lines[start:i])
    appended_lines.append(line)
    added_keys.append(key)

if appended_lines:
    if target_text and not target_text.endswith("\n"):
        target_text += "\n"
    if target_text and not target_text.endswith("\n\n"):
        target_text += "\n"
    target_path.write_text(target_text + "\n".join(appended_lines) + "\n", encoding="utf-8")

# 値は出力しない（キー名のみ）。
sys.stdout.write(" ".join(added_keys))
PY
  )"; then
    echo "警告: $target_file の不足キーの補完に失敗しました。本体の $(basename "$source_file") と見比べてください。" >&2
    return 0
  fi
  if [[ -n "$added" ]]; then
    echo "#$label: $(basename "$target_file") に不足していたキーを本体から追記しました: $added"
  fi
}

# worktreeへenvファイルを用意する。
#   - worktree側に無ければ本体からコピーする
#   - 既にあれば尊重し、不足キーだけを追記する（ローカルで書き換えている場合を壊さない）
#   - 本体側に無ければ何もしない（そのリポジトリがenvファイルを使わない場合がある）
#
#   $1 ログの見出しに使うラベル
#   $2 本体チェックアウトのディレクトリ
#   $3 worktreeのディレクトリ
#   $4.. 対象のファイル名（例: .env.local .env）
supply_env_files() {
  local label="$1" source_dir="$2" target_dir="$3"
  shift 3
  local name
  for name in "$@"; do
    if [[ ! -f "$source_dir/$name" ]]; then
      continue
    fi
    if [[ ! -f "$target_dir/$name" ]]; then
      cp "$source_dir/$name" "$target_dir/$name"
      echo "#$label: $name を本体からコピーしました。"
    else
      sync_missing_env_keys "$label" "$source_dir/$name" "$target_dir/$name"
    fi
  done
}
