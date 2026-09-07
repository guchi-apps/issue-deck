#!/usr/bin/env bash
# 計画レビュー（G1）のコメントが投稿されるまで待つ（#2864）。
#
# **なぜ要るか。** `21.plan-required`のIssueでは、計画コメントの投稿をきっかけに計画レビューが
# 自動で走る（`src/lib/dispatch/session-plan.ts`の`requestPlanReview`）。実測では計画の投稿から
# 3分26秒〜5分45秒で届き、**実装セッションがPRを出すより前**に出揃っている。それでも指摘が
# 2本目のPRになるのは、到着が遅いからではなく**PRを出す直前に読み直していない**ため
# （#2860はレビューがPR作成の25秒前に届いていたのに、反映が別コミット・別PRになった）。
# develop向けPRは作成から約90秒で自動マージされるので、出してから気付いても間に合わない。
#
# そこで`gh pr create`の直前にこれを1回だけ実行する。ほとんどの場合レビューは既に届いていて
# 即座に返り、待つのは早く実装が終わったときだけになる。
#
# **待ち切れなくてもセッションは止めない。** 計画レビューは積まれても見送られることがあり
# （pollerの同時本数の上限。見送りはジョブにしか残らずIssueには何も投稿されない）、
# Issueの側から「来ない」と「まだ来ていない」は区別できない。上限まで待ったらそのまま進む。
#
# 使い方:
#   scripts/wait-plan-review.sh 2864
#   scripts/wait-plan-review.sh 2864 --repo guchi-apps/issue-deck --timeout 360
#
# オプション:
#   --repo <owner/name>  対象リポジトリ（既定 カレントのgitリモートからghが解決する）
#   --timeout <秒>       待つ上限（既定 360。実測の最大5分45秒より少し長い）
#   --interval <秒>      問い合わせの間隔（既定 30）
#
# 出力（標準出力の1行目が結果。終了コードは待ち切れなかった場合も0）:
#   found    … 計画レビューが投稿されている（続けて本文を出力する。読んでから進む）
#   skipped  … `21.plan-required`が付いておらず、そもそもレビューは走らない
#   timeout  … 上限まで待っても届かなかった。そのまま進んでよい
set -euo pipefail

PLAN_REQUIRED_LABEL="21.plan-required"
REVIEW_MARKER="<!-- supervisor:plan-review -->"
DEFAULT_TIMEOUT_SECONDS=360
DEFAULT_INTERVAL_SECONDS=30

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

issue_number=""
repo=""
timeout_seconds="$DEFAULT_TIMEOUT_SECONDS"
interval_seconds="$DEFAULT_INTERVAL_SECONDS"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --timeout)
      timeout_seconds="${2:-}"
      shift 2
      ;;
    --interval)
      interval_seconds="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "不明なオプション: $1" >&2
      exit 2
      ;;
    *)
      issue_number="$1"
      shift
      ;;
  esac
done

if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
  echo "Issue番号を指定してください（例: scripts/wait-plan-review.sh 2864）" >&2
  exit 2
fi
if ! [[ "$timeout_seconds" =~ ^[0-9]+$ ]] || ! [[ "$interval_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "--timeout / --interval には秒数を指定してください" >&2
  exit 2
fi

gh_args=()
if [ -n "$repo" ]; then
  gh_args=(--repo "$repo")
fi

# ラベルは待つ前に1回だけ見る。`21.plan-required`が無ければレビューは積まれないので、
# ここで待つと必ず上限いっぱい空振りする
if ! gh issue view "$issue_number" "${gh_args[@]}" --json labels \
  --jq '.labels[].name' 2>/dev/null | grep -qx "$PLAN_REQUIRED_LABEL"; then
  echo "skipped"
  echo "${PLAN_REQUIRED_LABEL}が付いていないため、計画レビューは走りません。そのまま進んでください。"
  exit 0
fi

# 見るのは**最新の計画コメントより後**に投稿されたレビューだけ。計画を出し直した場合、
# 前の計画へのレビューを読んで「反映済み」と誤認しないようにする
plan_posted_at() {
  gh issue view "$issue_number" "${gh_args[@]}" --json comments \
    --jq '[.comments[] | select((.body | contains("<!-- issue-deck-agent:planner -->")) or (.body | contains("<!-- issue-deck-plan-type:"))) | .createdAt] | last // ""'
}

latest_review() {
  local since="$1"
  gh issue view "$issue_number" "${gh_args[@]}" --json comments \
    --jq "[.comments[] | select((.body | contains(\"$REVIEW_MARKER\")) and (.createdAt > \"$since\")) | .body] | last // \"\""
}

# 計画コメントが見つからない場合は、時刻の下限を空文字にして全件を対象にする
# （フックの投稿に失敗して手で計画を出した場合など）
since="$(plan_posted_at)"

deadline=$((SECONDS + timeout_seconds))
while :; do
  body="$(latest_review "$since")"
  if [ -n "$body" ]; then
    echo "found"
    printf '%s\n' "$body"
    exit 0
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    break
  fi
  sleep "$interval_seconds"
done

echo "timeout"
echo "計画レビューは${timeout_seconds}秒待っても投稿されませんでした。見送られた可能性があるため、そのまま進んでください。"
exit 0
