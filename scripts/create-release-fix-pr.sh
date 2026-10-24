#!/usr/bin/env bash
# リリース修正の内部確認（#4410）が完了しているときだけ、develop向けの修正PRを1件作る。
#
# 使い方: scripts/create-release-fix-pr.sh [--repo <owner/repo>] <issue番号> <PRタイトル> <PR本文ファイル>
#
# **修正したリポジトリのworktreeで実行する。** ブランチの確認とPRの作成は実行したディレクトリのリポジトリで行い、
# 報告先は`--repo`、無ければそのoriginで決まる（#4964。スクリプトの置き場所＝issue-deckのチェックアウトは見ない）。
#
# - 内部確認つきの修正Issueでは、`gh pr create`を直接使わずこのスクリプトを通す。
#   サーバーのゲート判定（独立レビュー実施・未解決指摘0・必要テスト合格が、**今のpush済みの内容**に対して揃っているか）を
#   確かめ、揃っていなければPRを作らず理由を出して終了する（終了コード1）。
# - ローカルの`HEAD`が`origin/issue-<番号>`と違う（未pushの変更がある）ときも作らない。
# - 同じブランチに開いているPRがあれば、新しく作らずそのURLを出す（再実行でPRを重複作成しない）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 || { echo "--repoには owner/repo を渡してください" >&2; exit 2; } ;;
    --repo=*) repo="${1#--repo=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- "${args[@]}"

issue="${1:-}"; title="${2:-}"; body_file="${3:-}"
[[ "$issue" =~ ^[0-9]+$ && -n "$title" && -f "$body_file" ]] || { echo "使い方: $0 <issue番号> <PRタイトル> <PR本文ファイル>" >&2; exit 2; }
branch="issue-$issue"

WORK="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "修正したリポジトリのworktreeで実行してください" >&2; exit 2; }
origin_repo="$(git -C "$WORK" remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
[[ -n "$repo" ]] || repo="$origin_repo"
[[ "$repo" == "$origin_repo" ]] || { echo "--repo（$repo）と実行したworktreeのリポジトリ（$origin_repo）が違います。修正したリポジトリのworktreeで実行してください" >&2; exit 2; }

existing="$(gh pr list --repo "$repo" --head "$branch" --base develop --state open --json url --jq '.[0].url // empty')"
if [[ -n "$existing" ]]; then echo "すでに開いているPRがあります: $existing"; exit 0; fi

git -C "$WORK" fetch -q origin "$branch"
local_sha="$(git -C "$WORK" rev-parse HEAD)"
remote_sha="$(git -C "$WORK" rev-parse "origin/$branch")"
[[ "$local_sha" == "$remote_sha" ]] || { echo "未pushの変更があります（HEAD=${local_sha:0:7} / origin=${remote_sha:0:7}）。pushして内部確認をやり直してください" >&2; exit 1; }

status="$("$ROOT/scripts/report-release-fix-round.sh" status "$issue" --repo "$repo")" || { echo "$status" >&2; exit 1; }
if [[ "$(jq -r '.gate.complete' <<<"$status")" != "true" ]]; then
  echo "内部確認が完了していないため、PRを作りません: $(jq -r '.gate.message' <<<"$status")" >&2
  exit 1
fi
if [[ "$(jq -r '.gate.targetSha' <<<"$status")" != "$remote_sha" ]]; then
  echo "内部確認を完了した内容と、pushした内容が違います。確認をやり直してください" >&2
  exit 1
fi

gh pr create --repo "$repo" --base develop --head "$branch" --title "$title" --body-file "$body_file"
