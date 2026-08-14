#!/usr/bin/env bash
# ローカル起動プロトコル（#1073）への適合を検査する。
#
# 使い方:
#   scripts/check-local-session-contract.sh          issue-deck自身を検査する（CI用。違反で終了コード1）
#   scripts/check-local-session-contract.sh --all    対応表の全リポジトリを検査して一覧表示する
#
# ワンクリック起動（画面の「ローカルで開始」）は、対象リポジトリの scripts/start-issue.sh を
# 呼ぶ形で成り立っている。実体がリポジトリごとにあるため、ファイルが存在しても約束を守って
# いるとは限らない。守っていないと起動時に無言で固まる（ISSUE_DECK_SKIP_LAN_SETUP を解釈
# しないリポジトリでは、UACを承認しても待ちから戻らない）。
#
# そこで冒頭のマーカー行を対応可否の単一の真実として扱い、ここで機械的に検査する。
# 契約の内容は docs/multi-agent/local-quick-start.md を参照。
#
# 検査できるのは「宣言があるか」「約束が要求する環境変数を解釈しているか」までで、
# 実際の挙動（フォアグラウンドで起動するか・worktreeを再利用するか）までは見ない。
# scripts/check-cross-repo-guide-sync.sh と同じく、存在チェックに徹する。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_SOURCE="$ROOT/src/lib/local-session.ts"
CONFIG_FILE="${ISSUE_DECK_LOCAL_REPOS_CONFIG:-$HOME/.config/issue-deck/local-repos.conf}"

# 契約が要求する環境変数。start-issue.sh がこれらを解釈していることを確かめる。
# 名前を変えるときは src/lib/local-session.ts・scripts/start-local-session.sh も揃える。
REQUIRED_ENV_VARS=(ISSUE_DECK_SKIP_LAN_SETUP ISSUE_DECK_DEV_PORT_BASE)

# v2で増えた約束のうち、存在チェックで見られるもの（#1178）。
# **v2以上を宣言しているリポジトリにだけ課す。** 受け口はv1のリポジトリも受け入れるため、
# v1のままのものをここで違反扱いにしない。
V2_REQUIRED_TOKENS=(tmux)

# src/lib/local-session.ts が持つ版数を正とする。画面と検査で版数がずれないようにするため、
# シェル側で数字を二重に書かない。
expected_version() {
  local version
  version="$(grep -oP 'LOCAL_SESSION_CONTRACT_VERSION\s*=\s*\K[0-9]+' "$CONTRACT_SOURCE" | head -1)"
  if [[ -z "$version" ]]; then
    echo "Error: $CONTRACT_SOURCE から LOCAL_SESSION_CONTRACT_VERSION を読み取れません。" >&2
    exit 1
  fi
  printf '%s\n' "$version"
}

# 対象の start-issue.sh を検査する。違反があれば理由を標準出力へ書き、1を返す。
check_script() {
  local label="$1"
  local script_path="$2"
  local expected="$3"
  local problems=()

  if [[ ! -f "$script_path" ]]; then
    echo "  ✗ $label: scripts/start-issue.sh がありません（$script_path）"
    return 1
  fi

  local declared
  declared="$(grep -oP '^#\s*issue-deck-local-session:\s*v\K[0-9]+' "$script_path" | head -1 || true)"

  if [[ -z "$declared" ]]; then
    problems+=("マーカー行 '# issue-deck-local-session: v$expected' がありません")
  elif [[ "$declared" -gt "$expected" ]]; then
    problems+=("宣言された版数 v$declared は、issue-deck側が扱える v$expected より新しいです")
  fi

  local var
  for var in "${REQUIRED_ENV_VARS[@]}"; do
    if ! grep -q "$var" "$script_path"; then
      problems+=("$var を解釈していません")
    fi
  done

  if [[ -n "$declared" && "$declared" -ge 2 ]]; then
    local token
    for token in "${V2_REQUIRED_TOKENS[@]}"; do
      if ! grep -q "$token" "$script_path"; then
        problems+=("v$declared を宣言していますが $token を使う出口がありません")
      fi
    done
  fi

  if [[ ${#problems[@]} -eq 0 ]]; then
    echo "  ✓ $label: v${declared}"
    return 0
  fi

  echo "  ✗ $label"
  local problem
  for problem in "${problems[@]}"; do
    echo "      - $problem"
  done
  return 1
}

EXPECTED_VERSION="$(expected_version)"

if [[ "${1:-}" != "--all" ]]; then
  # CI用。issue-deck自身が契約を満たしているかだけを見る。誰かが start-issue.sh から
  # ISSUE_DECK_SKIP_LAN_SETUP の解釈を落とすと、ここで落ちる。
  echo "ローカル起動プロトコル v$EXPECTED_VERSION の適合を検査します（issue-deck自身）"
  if check_script "guchi-apps/issue-deck" "$ROOT/scripts/start-issue.sh" "$EXPECTED_VERSION"; then
    exit 0
  fi
  echo >&2
  echo "Error: issue-deck自身が契約を満たしていません。docs/multi-agent/local-quick-start.md を参照してください。" >&2
  exit 1
fi

# --all: 対応表に載っている全リポジトリを見る。ローカルのチェックアウトを読むため、
# 手元にクローンしていないリポジトリは検査できない。CIでは使わず情報表示に徹する
# （scripts/check-workflow-sync-drift.sh と同じ位置づけ）。
echo "ローカル起動プロトコル v$EXPECTED_VERSION の適合を検査します（対応表の全リポジトリ）"
echo "対応表: $CONFIG_FILE"
echo

check_script "guchi-apps/issue-deck" "$ROOT/scripts/start-issue.sh" "$EXPECTED_VERSION" || true

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo
  echo "対応表がまだありません。scripts/local-repos.conf.example を参考に作成してください。"
  exit 0
fi

# 対応表のパーサは scripts/start-local-session.sh の resolve_repo_path と同じ規則にする
# （最初の空白までがリポジトリ名、残りがパス。パスに空白を含んでよい）。
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^[[:space:]]*([^[:space:]]+)[[:space:]]+(.+)$ ]] || continue
  name="${BASH_REMATCH[1]}"
  path="${BASH_REMATCH[2]}"
  path="${path%"${path##*[![:space:]]}"}"
  path="${path/#\~/$HOME}"
  [[ "$name" == "guchi-apps/issue-deck" ]] && continue
  check_script "$name" "$path/scripts/start-issue.sh" "$EXPECTED_VERSION" || true
done <"$CONFIG_FILE"

echo
echo "違反があるリポジトリは、ワンクリック起動が受け口の段階で停止します（起動して固まるよりは安全）。"
