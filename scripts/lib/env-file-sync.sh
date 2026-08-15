#!/usr/bin/env bash
# worktreeの環境変数ファイルを本体チェックアウトから供給・追従させる（#1099）。
#
# `scripts/start-issue.sh`（issue-deck自身）と`scripts/generic-start-issue.sh`（汎用ランチャー・
# #1224）が共有する。**片方だけが直ると、経路によって環境変数の揃い方が変わる。**
#
# worktreeの`.env.local`は作成時のコピーで固定されるため、本体に後から足した環境変数が既存の
# worktreeへ届かず、本体と違う挙動で画面確認をすることになっていた。既存キーの値には原則触れない
# （ローカルで書き換えている場合を壊さないため）。値はログに出さず、キー名だけを表示する。
#
# **例外は、worktree側が空かCI用プレースホルダ（`ci-placeholder`）のままの値**（#1419）。本体の
# `.env.local`にCI用のダミー値が入ったままサブPCのworktreeが量産され、どの開発サーバーでも
# ログインできなくなっていた。既存キーを一切触らない作りだと、本体を実値に直しても既存worktreeは
# 直らない。**まだ何も入っていないと言い切れる値だけを、本体側が実値のときに限って上書きする。**
# 追従させたくないキーはコメントアウト（`#KEY=`）しておけばこの経路も通らない。
#
# **複製先（`~/.local/share/issue-deck/`）へは配らない。** 受け口はこのライブラリを使わない。

# 本体のenvファイルにあってworktree側に無いキーを値ごと追記し、worktree側が空・CI用プレースホルダの
# ままのキーは本体の値で上書きする。
#   $1 ログの見出しに使うラベル（Issue番号など）
#   $2 本体側のファイル
#   $3 worktree側のファイル
sync_missing_env_keys() {
  local label="$1"
  local source_file="$2"
  local target_file="$3"
  # 補完に失敗してもセッションの起動自体は妨げない（起動できない方が困るため）。
  local result
  if ! result="$(python3 - "$source_file" "$target_file" <<'PY'
import pathlib
import re
import sys

source_path = pathlib.Path(sys.argv[1])
target_path = pathlib.Path(sys.argv[2])

# PORTはworktreeごとに採番して別途書き込むため、同期の対象から外す。
EXCLUDED_KEYS = {"PORT"}

# CIワークフローがビルドを通すためだけに入れるダミー値の目印（#1419）。
# src/lib/supabase/config.ts の CI_PLACEHOLDER_MARKER と同じ値。
CI_PLACEHOLDER_MARKER = "ci-placeholder"

ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
# コメントアウトされた代入は「意図的に無効化している」とみなし、上書き復活させない。
COMMENTED_ASSIGNMENT = re.compile(r"^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


def needs_replacement(raw_value):
    """worktree側の値が「まだ何も入っていない」と言い切れるか（空 or CI用プレースホルダ）。"""
    value = raw_value.strip().strip("\"'")
    return not value or CI_PLACEHOLDER_MARKER in value


def is_usable(raw_value):
    value = raw_value.strip().strip("\"'")
    return bool(value) and CI_PLACEHOLDER_MARKER not in value


source_lines = source_path.read_text(encoding="utf-8").splitlines()
target_text = target_path.read_text(encoding="utf-8")

existing = set()
for line in target_text.splitlines():
    matched = ASSIGNMENT.match(line) or COMMENTED_ASSIGNMENT.match(line)
    if matched:
        existing.add(matched.group(1))

# 本体側の実値。同じキーが複数あれば後勝ち（シェルがsourceしたときと同じ）。
source_values = {}
for line in source_lines:
    matched = ASSIGNMENT.match(line)
    if matched and matched.group(1) not in EXCLUDED_KEYS:
        source_values[matched.group(1)] = matched.group(2)

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

# worktree側が空・CI用プレースホルダのままのキーだけ、本体の実値で置き換える（#1419）。
# ローカルで書き換えた値・本体側も空/プレースホルダのキーには触らない。
# 追従させたくないキーはコメントアウト（`#KEY=`）しておけば、この経路も通らない。
replaced_keys = []
target_lines = target_text.splitlines()
for i, line in enumerate(target_lines):
    matched = ASSIGNMENT.match(line)
    if not matched:
        continue
    key = matched.group(1)
    if key in EXCLUDED_KEYS or not needs_replacement(matched.group(2)):
        continue
    source_value = source_values.get(key)
    if source_value is None or not is_usable(source_value):
        continue
    target_lines[i] = f"{key}={source_value.strip()}"
    replaced_keys.append(key)

if replaced_keys:
    target_text = "\n".join(target_lines) + "\n"

if appended_lines or replaced_keys:
    new_text = target_text
    if appended_lines:
        if new_text and not new_text.endswith("\n"):
            new_text += "\n"
        if new_text and not new_text.endswith("\n\n"):
            new_text += "\n"
        new_text += "\n".join(appended_lines) + "\n"
    target_path.write_text(new_text, encoding="utf-8")

# 値は出力しない（キー名のみ）。1行目が追記したキー、2行目が置き換えたキー。
sys.stdout.write(" ".join(added_keys) + "\n" + " ".join(replaced_keys) + "\n")
PY
  )"; then
    echo "警告: $target_file の不足キーの補完に失敗しました。本体の $(basename "$source_file") と見比べてください。" >&2
    return 0
  fi
  local added replaced
  added="$(printf '%s' "$result" | sed -n 1p)"
  replaced="$(printf '%s' "$result" | sed -n 2p)"
  if [[ -n "$added" ]]; then
    echo "#$label: $(basename "$target_file") に不足していたキーを本体から追記しました: $added"
  fi
  if [[ -n "$replaced" ]]; then
    echo "#$label: $(basename "$target_file") の空・CI用プレースホルダのままだったキーを本体の値で置き換えました: $replaced"
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
