#!/usr/bin/env bash
# 計画が前提としたコミット（`<!-- plan-base: <SHA> -->`）からの陳腐化検知（#1215）。
#
# **計画の前提は実際に2回無効になっている。** #1200 の計画中に #1179（pollerとジョブキュー）と
# #1205（権限モードの既定を`auto`へ）がdevelopへ入り、「常駐先が無いから作る」「ツール承認への
# 応答が要る」という前提がどちらも消えた（[docs/multi-agent/gates.md](../../docs/multi-agent/gates.md)）。
# 計画を書いた時点のdevelopのSHAは計画コメントに残っている（`src/lib/dispatch/session-plan.ts`が
# `ExitPlanMode`フックの報告を受けて書く）ので、そこから何が変わったかは決定的に出せる。
#
# **止めない。必ず見せるだけにする。** 無関係なマージのたびに無人実行やローカルの起動が
# 詰まるのを避けるため、ここのどの関数も**必ず0で返る**。
#
# このファイル自体は実行せず、source して使う。

# `gh issue view --json comments` のJSON（stdin）から、**最後の**`<!-- plan-base: <SHA> -->`を返す。
# 見つからなければ何も出力しない（計画フェーズを経ていないIssue・マーカーが無かった頃の古い計画）。
#
# 通すのは**7〜40桁の16進だけ**（`src/lib/dispatch/session-plan.ts`の`parsePlanBaseSha`と同じ規則）。
# 読んだ値は`git log`の引数へそのまま渡るため、形の検査をここで済ませておく。
plan_base_sha_from_comments() {
  local script
  script="$(
    cat <<'PY'
import json
import re
import sys

PATTERN = re.compile(r"<!--\s*plan-base:\s*([0-9a-f]{7,40})\s*-->")

try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)

if isinstance(data, dict):
    comments = data.get("comments") or []
elif isinstance(data, list):
    comments = data
else:
    comments = []

found = None
for comment in comments:
    if not isinstance(comment, dict):
        continue
    for matched in PATTERN.finditer(comment.get("body") or ""):
        found = matched.group(1)

if found:
    print(found)
PY
  )"
  python3 -c "$script" 2>/dev/null || true
}

# 計画の前提から `origin/<ベースブランチ>` へ入った変更を1行1コミットで返す。
#
#   plan_base_changes <リポジトリのパス> <SHA> [ベースブランチ] [最大行数]
#
# **どの経路でも必ず0で返る。** 呼び出し側は `set -e` の下で呼ぶ。
# SHAがこのリポジトリに無い場合（他ブランチのコミット・浅いclone・SHAの取り違え）は、
# その旨の1行だけを返す。**「変化なし」と取り違えないこと**が要点で、黙って空を返すと
# 前提が崩れていないように見えてしまう。
plan_base_changes() {
  local dir="$1" sha="$2" base="${3:-develop}" max="${4:-20}"
  [[ -n "$sha" ]] || return 0

  if ! git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    printf '（%s はこのリポジトリに存在しないため、前提の変化を確認できませんでした）\n' "$sha"
    return 0
  fi

  local log
  if ! log="$(git -C "$dir" log --oneline "${sha}..origin/${base}" 2>/dev/null)"; then
    printf '（origin/%s との差分を取得できませんでした）\n' "$base"
    return 0
  fi
  if [[ -z "$log" ]]; then
    printf '（計画を立てた時点から origin/%s は変わっていません）\n' "$base"
    return 0
  fi

  local total
  total="$(printf '%s\n' "$log" | grep -c . || true)"
  if [[ "$total" -le "$max" ]]; then
    printf '%s\n' "$log"
  else
    printf '%s\n' "$log" | head -n "$max"
    printf '…他%d件\n' "$((total - max))"
  fi
  return 0
}
