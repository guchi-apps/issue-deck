#!/usr/bin/env bash
# ローカルセッションのトークン使用量を集計して端末へ出す（#2350）。
#
# 使い方:
#   scripts/session-usage.sh                     直近7日をセッション別に多い順で出す
#   scripts/session-usage.sh 2350                Issue番号で絞る（期間の既定は無制限）
#   scripts/session-usage.sh issue-deck-issue-2350   tmuxセッション名で絞る
#   scripts/session-usage.sh --days 21           集計する日数（既定7・今日を含む）
#   scripts/session-usage.sh --all               期間で絞らない
#   scripts/session-usage.sh --by kind           種別別（実装／計画レビュー／横断質問／その他）
#   scripts/session-usage.sh --by repo|day|model 別のまとめ方
#   scripts/session-usage.sh --limit 50          表に出す行数（既定20・0で全件）
#   scripts/session-usage.sh --json              正規化JSONをそのまま出す
#
# 環境変数:
#   CLAUDE_PROJECTS_DIR   転記の置き場（既定は ~/.claude/projects）
#
# ## なぜ要るか
#
# ローカルセッションが全消費の約93%を占めるのに、**そこだけ計測が無い**
# （`guchi-apps/question#34`の調査。直近21日でOpus 5のAPI換算 約$6,556）。無人実行は #903 が
# Job Summaryへ出し、サブスクの消費率は ops-dashboard が出すが、「どのIssueのセッションが
# いくら使ったか」はどこにも出なかった。削減策の効果を測るために、まず出す。
#
# ## 作法
#
# **これは計器であって役ではない**（[docs/multi-agent/gates.md](../docs/multi-agent/gates.md)）。
# LLMを使わず決定的に集計し、判断はしない。常駐せず、人が叩いたときに1回読んで終わる。
# 集計の中身と注意点は `scripts/lib/session-usage.sh` の冒頭を参照。
#
# **出す数字はAPI換算の目安で、サブスクの実費ではない。** 実費に相当する消費率は
# ops-dashboard の Claude 使用量表示（`/api/claude-usage`）と端末の `/usage` で見る。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 集計と整形。**転記を開くのはこのlibだけ**にしてある。
# shellcheck source=scripts/lib/session-usage.sh
source "$SCRIPT_DIR/lib/session-usage.sh"

CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

DAYS=7
DAYS_EXPLICIT=0
ALL=0
BY="session"
LIMIT=20
OUTPUT="table"
TARGET=""

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

# 使い方はファイル冒頭のコメントを正とし、`## なぜ要るか`の手前までをそのまま出す
# （説明を2か所に持つと必ず片方が古くなる。`scripts/inspect-session.sh`と同じ）。
usage() {
  awk 'NR == 1 { next } /^# ## / { exit } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while (($#)); do
  case "$1" in
    --days)
      [[ ${2:-} =~ ^[0-9]+$ ]] || die "--days には日数を渡してください"
      DAYS="$2"
      DAYS_EXPLICIT=1
      ALL=0
      shift 2
      ;;
    --all)
      ALL=1
      shift
      ;;
    --by)
      case "${2:-}" in
        session | kind | repo | day | model) BY="$2" ;;
        *) die "--by には session / kind / repo / day / model のいずれかを渡してください" ;;
      esac
      shift 2
      ;;
    --limit)
      [[ ${2:-} =~ ^[0-9]+$ ]] || die "--limit には件数を渡してください（0で全件）"
      LIMIT="$2"
      shift 2
      ;;
    --json)
      OUTPUT="json"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      die "不明なオプション: $1（--help で使い方を出せます）"
      ;;
    *)
      [[ -z "$TARGET" ]] || die "対象は1つだけ指定してください（$TARGET と $1）"
      TARGET="$1"
      shift
      ;;
  esac
done

command -v python3 >/dev/null 2>&1 || die "python3 がありません。集計に必要です"
[[ -d "$CLAUDE_PROJECTS_DIR" ]] ||
  die "転記の置き場がありません: $CLAUDE_PROJECTS_DIR（このホストでClaude Codeが動いていない可能性があります）"

# --- 対象の解決 ---
ISSUE_FILTER=""
REPO_FILTER=""
if [[ -n "$TARGET" ]]; then
  if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
    ISSUE_FILTER="$TARGET"
  elif [[ "$TARGET" =~ ^(.+)-issue-([1-9][0-9]*)$ ]]; then
    # セッション名は末尾の区切りで割る（`scripts/lib/fleet-status.sh`と同じ規則）。
    REPO_FILTER="${BASH_REMATCH[1]}"
    ISSUE_FILTER="${BASH_REMATCH[2]}"
  else
    die "対象はIssue番号か <リポジトリ名>-issue-<番号> の形で指定してください: $TARGET"
  fi
  # **1つのセッションを見るときは期間で絞らない。** 何日前に走ったかを覚えている前提に
  # したくないため、`--days`を明示したときだけ期間を効かせる。
  ((DAYS_EXPLICIT)) || ALL=1
fi

# --- 集計する期間 ---
# `--days 7` は「今日を含む直近7日」。日付の境界はローカル時刻で切る。
CUTOFF=0
if ((!ALL)); then
  CUTOFF="$(date -d "$((DAYS > 0 ? DAYS - 1 : 0)) days ago 00:00" +%s 2>/dev/null || echo 0)"
fi

JSON="$(session_usage_transcripts "$CLAUDE_PROJECTS_DIR" "$CUTOFF" |
  session_usage_aggregate "$CUTOFF" "$ISSUE_FILTER" "$REPO_FILTER")"

if [[ "$OUTPUT" == "json" ]]; then
  printf '%s\n' "$JSON"
  exit 0
fi

if ((ALL)); then
  printf '集計期間: 全期間'
else
  printf '集計期間: 直近%s日（%s 以降）' "$DAYS" "$(date -d "@$CUTOFF" +%Y-%m-%d 2>/dev/null || echo '?')"
fi
if [[ -n "$ISSUE_FILTER" ]]; then
  printf '　対象: %s#%s' "$REPO_FILTER" "$ISSUE_FILTER"
fi
printf '\n転記: %s\n\n' "$CLAUDE_PROJECTS_DIR"

printf '%s\n' "$JSON" | session_usage_render_table "$BY" "$LIMIT"
