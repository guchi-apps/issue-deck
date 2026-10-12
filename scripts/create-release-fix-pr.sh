#!/usr/bin/env bash
# リリース修正の内部確認（#4410）が完了しているときだけ、develop向けの修正PRを1件作る。
#
# 使い方: scripts/create-release-fix-pr.sh <issue番号> <PRタイトル> <PR本文ファイル>
#
# - 内部確認つきの修正Issueでは、`gh pr create`を直接使わずこのスクリプトを通す。
#   サーバーのゲート判定（独立レビュー実施・未解決指摘0・必要テスト合格が、**今のpush済みの内容**に対して揃っているか）を
#   確かめ、揃っていなければPRを作らず理由を出して終了する（終了コード1）。
# - ローカルの`HEAD`が`origin/issue-<番号>`と違う（未pushの変更がある）ときも作らない。
# - 同じブランチに開いているPRがあれば、新しく作らずそのURLを出す（再実行でPRを重複作成しない）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
issue="${1:-}"; title="${2:-}"; body_file="${3:-}"
[[ "$issue" =~ ^[0-9]+$ && -n "$title" && -f "$body_file" ]] || { echo "使い方: $0 <issue番号> <PRタイトル> <PR本文ファイル>" >&2; exit 2; }
branch="issue-$issue"

repo="$(git -C "$ROOT" remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"

existing="$(gh pr list --repo "$repo" --head "$branch" --base develop --state open --json url --jq '.[0].url // empty')"
if [[ -n "$existing" ]]; then echo "すでに開いているPRがあります: $existing"; exit 0; fi

git -C "$ROOT" fetch -q origin "$branch"
local_sha="$(git -C "$ROOT" rev-parse HEAD)"
remote_sha="$(git -C "$ROOT" rev-parse "origin/$branch")"
[[ "$local_sha" == "$remote_sha" ]] || { echo "未pushの変更があります（HEAD=${local_sha:0:7} / origin=${remote_sha:0:7}）。pushして内部確認をやり直してください" >&2; exit 1; }

status="$("$ROOT/scripts/report-release-fix-round.sh" status "$issue")" || { echo "$status" >&2; exit 1; }
if [[ "$(jq -r '.gate.complete' <<<"$status")" != "true" ]]; then
  echo "内部確認が完了していないため、PRを作りません: $(jq -r '.gate.message' <<<"$status")" >&2
  exit 1
fi
if [[ "$(jq -r '.gate.targetSha' <<<"$status")" != "$remote_sha" ]]; then
  echo "内部確認を完了した内容と、pushした内容が違います。確認をやり直してください" >&2
  exit 1
fi

gh pr create --repo "$repo" --base develop --head "$branch" --title "$title" --body-file "$body_file"
