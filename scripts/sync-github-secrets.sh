#!/usr/bin/env bash
# 1Password（正）から GitHub の secret / variable へ値を同期する（#1302）。
#
# デプロイのたびに1Passwordを読むとサービスアカウントの日次レート制限
# （1Passwordアカウント全体で1,000リクエスト/日）を使い切るため、実行時の取得先を
# GitHubへ移した。このスクリプトは「値が変わったとき」にだけ実行する。
#
# 重要: ここで使う `op` は**個人アカウントのセッション**であり、サービスアカウントの
# 枠を消費しない。したがってサービスアカウントが枯渇していても実行できる。
#
# 使い方:
#   op signin                      # 先に個人アカウントでサインインしておく
#   scripts/sync-github-secrets.sh --dry-run
#   scripts/sync-github-secrets.sh
#   scripts/sync-github-secrets.sh --only SIGNALY_WEBHOOK_URL,HOST
#
# 必要な権限: gh の `repo` スコープ（repo secret/variable の書き込み）
set -euo pipefail

REPO="${REPO:-guchi-apps/issue-deck}"
MANIFEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/secrets-manifest.tsv"
DRY_RUN=false
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -f "$MANIFEST" ]] || { echo "マニフェストが見つかりません: $MANIFEST" >&2; exit 1; }
command -v op >/dev/null || { echo "1Password CLI (op) がインストールされていません" >&2; exit 1; }
command -v gh >/dev/null || { echo "GitHub CLI (gh) がインストールされていません" >&2; exit 1; }

if ! op whoami >/dev/null 2>&1; then
  echo "opにサインインしていません。先に 'op signin' を実行してください。" >&2
  echo "（個人アカウントのセッションを使うため、サービスアカウントの枠は消費しません）" >&2
  exit 1
fi

is_selected() {
  [[ -z "$ONLY" ]] && return 0
  [[ ",$ONLY," == *",$1,"* ]]
}

synced=0
skipped=0
failed=0

while IFS=$'\t' read -r key scope kind source; do
  [[ -z "${key:-}" || "$key" == \#* ]] && continue
  [[ -z "${source:-}" ]] && continue

  if ! is_selected "$key"; then
    continue
  fi

  if [[ "$scope" == "inherit" ]]; then
    echo "skip   $key（organization secretを使用するため同期しない）"
    skipped=$((skipped + 1))
    continue
  fi

  # 値の中身は絶対に出力しない。失敗時もop側のエラーのみを見せる。
  if ! value="$(op read "$source" 2>/dev/null)"; then
    echo "FAIL   $key（1Passwordから読めません: $source）" >&2
    failed=$((failed + 1))
    continue
  fi

  if [[ -z "$value" ]]; then
    echo "FAIL   $key（値が空です: $source）" >&2
    failed=$((failed + 1))
    continue
  fi

  if [[ "$DRY_RUN" == true ]]; then
    echo "dry    $key -> $kind ($REPO) ${#value}文字"
    synced=$((synced + 1))
    continue
  fi

  case "$kind" in
    secret) printf '%s' "$value" | gh secret set "$key" --repo "$REPO" --body-file - ;;
    var)    printf '%s' "$value" | gh variable set "$key" --repo "$REPO" --body-file - ;;
    *) echo "FAIL   $key（不明なKIND: $kind）" >&2; failed=$((failed + 1)); continue ;;
  esac
  echo "ok     $key -> $kind ($REPO)"
  synced=$((synced + 1))
done < "$MANIFEST"

echo
echo "同期=$synced スキップ=$skipped 失敗=$failed"
[[ "$failed" -eq 0 ]]
