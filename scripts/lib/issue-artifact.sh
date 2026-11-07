#!/usr/bin/env bash
# 見た目案の自己完結HTMLをIssueDeckへ登録し、IssueDeck配下のURLを返す（#2597・#5237）。
#
# 使い方:
#   scripts/lib/issue-artifact.sh <HTMLファイル> [--repo <owner/repo>] [--issue <番号>]
#
# ## claude.aiのアーティファクトを使わない理由（#5237）
#
# claude.aiの`Artifact`で公開すると、見た目案を出すたびにアカウントのアーティファクトが1件増え、
# 実装セッションだけで200件を超えて上限に掛かった。IssueDeckは公開のたびにHTMLの原本を受け取って
# 自分のオリジンから出している（#2154）ので、表示に要るのは原本だけで、claude.aiを通す必要が無い。
# Codexは元からこの経路（旧`codex-artifact.sh`）で登録しており、Claude Codeもここへ揃えた。
#
# ## 共有シークレットはセッションの環境変数へ渡さない
#
# 受け口（`/api/dispatch/sessions/artifact`）の認証は`DISPATCH_SECRET`で、`/claim`・`/report`と
# 共用している。**Claude Codeのセッション全体へexportすると、取り込んだ外部コンテンツに影響された
# 実行からも参照しやすくなる**ため、このスクリプトが実行時に`dispatch.env`から自分で読む
# （`scripts/fetch-issue-images.sh`と同じ形）。Codex向けに`run-issue-session.sh`が渡している
# 環境変数（`ISSUE_DECK_ARTIFACT_*`）は互換のため先に読む。
#
# ## 同じファイルパスで再実行すると、同じカードが差し替わる
#
# 受け口はリポジトリ×Issue×ファイルパスで上書きするので、直しを出すときはパスを変えない。

set -euo pipefail

usage() {
  echo "Usage: scripts/lib/issue-artifact.sh <HTMLファイル> [--repo <owner/repo>] [--issue <番号>]" >&2
}

CONFIG_FILE="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"

source_arg=""
repository="${ISSUE_DECK_REPO_SLUG:-}"
issue="${ISSUE_DECK_ISSUE_NUMBER:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repository="${2:-}"
      shift 2 || { usage; exit 2; }
      ;;
    --issue)
      issue="${2:-}"
      shift 2 || { usage; exit 2; }
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage
      exit 2
      ;;
    *)
      [[ -z "$source_arg" ]] || { usage; exit 2; }
      source_arg="$1"
      shift
      ;;
  esac
done
[[ -n "$source_arg" ]] || { usage; exit 2; }

SOURCE_PATH="$(realpath "$source_arg" 2>/dev/null || true)"
if [[ -z "$SOURCE_PATH" || ! -f "$SOURCE_PATH" ]]; then
  echo "エラー: HTMLファイルが見つかりません: $source_arg" >&2
  exit 1
fi
case "${SOURCE_PATH,,}" in
  *.html | *.htm) ;;
  *)
    echo "エラー: 登録できるのは.html/.htmファイルだけです: $SOURCE_PATH" >&2
    exit 1
    ;;
esac

dispatch_env_value() {
  local name="$1"
  [[ -f "$CONFIG_FILE" ]] || return 0
  # shellcheck disable=SC1090
  (set +eu; source "$CONFIG_FILE" >/dev/null 2>&1; printf '%s' "${!name:-}")
}

# リポジトリとIssue番号は、指定が無ければ作業中のgitから決める。Issue専用worktreeのブランチは
# `issue-<番号>`（`start-issue.sh`・`generic-start-issue.sh`が作る）。**他リポジトリのセッションでは
# このスクリプトがissue-deckの作業ツリーから呼ばれる**ので、見るのは呼び出し元のcwdのgitで、
# スクリプトの置き場所ではない。
if [[ -z "$repository" ]]; then
  repository="$(git config --get remote.origin.url 2>/dev/null |
    sed -E 's#^git@[^:]+:##; s#^ssh://[^/]+/##; s#^https?://[^/]+/##; s#\.git$##' || true)"
fi
if [[ -z "$issue" ]]; then
  branch="$(git branch --show-current 2>/dev/null || true)"
  if [[ "$branch" =~ ^issue-([0-9]+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
  fi
fi
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ || ! "$issue" =~ ^[1-9][0-9]*$ ]]; then
  echo "エラー: 登録先のリポジトリ・Issue番号が決まりません。Issue専用のworktree（ブランチ issue-<番号>）から実行するか、--repo と --issue を指定してください。" >&2
  exit 1
fi

API_URL="${ISSUE_DECK_ARTIFACT_API_URL:-}"
SECRET="${ISSUE_DECK_ARTIFACT_SECRET:-}"
HOST_NAME="${ISSUE_DECK_HOST_NAME:-}"
if [[ -z "$API_URL" ]]; then
  API_URL="$(dispatch_env_value APP_BASE_URL)"
  [[ -z "$API_URL" ]] || API_URL="${API_URL%/}/api/dispatch/sessions/artifact"
fi
[[ -n "$SECRET" ]] || SECRET="$(dispatch_env_value DISPATCH_SECRET)"
[[ -n "$HOST_NAME" ]] || HOST_NAME="$(dispatch_env_value DISPATCH_HOST_NAME)"
[[ -n "$HOST_NAME" ]] || HOST_NAME="$(hostname -s 2>/dev/null || true)"
if [[ -z "$API_URL" || -z "$SECRET" ]]; then
  echo "エラー: IssueDeckの登録先（APP_BASE_URL）か鍵（DISPATCH_SECRET）が見つかりません（$CONFIG_FILE）。" >&2
  exit 1
fi

PAYLOAD="$(
  SOURCE_PATH="$SOURCE_PATH" REPOSITORY="$repository" ISSUE="$issue" HOST_NAME="$HOST_NAME" \
    python3 - <<'PY' 2>/dev/null
import json
import os
import sys
from pathlib import Path

# 受け口（`src/lib/dispatch/session-artifact.ts`）と同じ上限
LIMIT = 2 * 1024 * 1024
raw = Path(os.environ["SOURCE_PATH"]).read_bytes()
if not raw.strip() or len(raw) > LIMIT:
    sys.exit(1)
print(json.dumps({
    "repository": os.environ["REPOSITORY"],
    "issue": int(os.environ["ISSUE"]),
    "hostName": os.environ.get("HOST_NAME") or None,
    "sourcePath": os.environ["SOURCE_PATH"],
    "html": raw.decode("utf-8"),
}, ensure_ascii=False))
PY
)" || {
  echo "エラー: HTMLを読み込めませんでした（空でなく、UTF-8・2MiB以下である必要があります）。" >&2
  exit 1
}

# **本文は標準入力から渡す。** 引数に載せると、1引数128KiBの上限（MAX_ARG_STRLEN）を超えた
# 時点で`curl`が起動できない（画像をdata URIで埋めた見た目案は数百KBになる）
RESPONSE="$(printf '%s' "$PAYLOAD" | curl -fsS --max-time 20 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  --data-binary @- \
  "$API_URL" 2>/dev/null)" || {
  echo "エラー: IssueDeckへアーティファクトを登録できませんでした。" >&2
  exit 1
}

ARTIFACT_ID="$(RESPONSE="$RESPONSE" python3 - <<'PY'
import json
import os

try:
    artifact = json.loads(os.environ["RESPONSE"]).get("artifact") or {}
    value = artifact.get("id")
except (TypeError, ValueError, AttributeError):
    value = None
if isinstance(value, str) and value:
    print(value)
PY
)"

if [[ -z "$ARTIFACT_ID" ]]; then
  echo "エラー: IssueDeckからアーティファクトURLを取得できませんでした。" >&2
  exit 1
fi

BASE_URL="${API_URL%/}"
BASE_URL="${BASE_URL%/api/dispatch/sessions/artifact}"
printf '%s/artifacts/%s\n' "${BASE_URL%/}" "$ARTIFACT_ID"
