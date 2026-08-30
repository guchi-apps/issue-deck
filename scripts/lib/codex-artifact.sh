#!/usr/bin/env bash
# Codex CLIで作った自己完結HTMLをIssueDeckへ登録する（#2597）。
#
# 使い方:
#   scripts/lib/codex-artifact.sh <HTMLファイル>
#
# APIの共有シークレットはプロンプトへ書かず、run-issue-session.shから環境変数で受け取る。
# このスクリプトはHTMLをIssueDeckへ保存し、別端末から開けるIssueDeck URLだけを標準出力へ返す。

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/lib/codex-artifact.sh <HTMLファイル>" >&2
  exit 2
fi

SOURCE_PATH="$(realpath "$1" 2>/dev/null || true)"
if [[ -z "$SOURCE_PATH" || ! -f "$SOURCE_PATH" ]]; then
  echo "エラー: HTMLファイルが見つかりません: $1" >&2
  exit 1
fi

API_URL="${ISSUE_DECK_ARTIFACT_API_URL:-}"
SECRET="${ISSUE_DECK_ARTIFACT_SECRET:-}"
REPOSITORY="${ISSUE_DECK_REPO_SLUG:-}"
ISSUE="${ISSUE_DECK_ISSUE_NUMBER:-}"
HOST_NAME="${ISSUE_DECK_HOST_NAME:-}"

if [[ -z "$API_URL" || -z "$SECRET" || -z "$REPOSITORY" || -z "$ISSUE" ]]; then
  echo "エラー: IssueDeckアーティファクト登録用のセッション情報がありません。Issue専用セッションから実行してください。" >&2
  exit 1
fi

PAYLOAD="$({
  SOURCE_PATH="$SOURCE_PATH" REPOSITORY="$REPOSITORY" ISSUE="$ISSUE" HOST_NAME="$HOST_NAME" \
    python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["SOURCE_PATH"])
print(json.dumps({
    "repository": os.environ["REPOSITORY"],
    "issue": int(os.environ["ISSUE"]),
    "hostName": os.environ.get("HOST_NAME") or None,
    "sourcePath": str(path),
    "html": path.read_text(encoding="utf-8"),
}, ensure_ascii=False))
PY
} 2>/dev/null)" || {
  echo "エラー: HTMLを読み込めませんでした（UTF-8・2MiB未満である必要があります）。" >&2
  exit 1
}

RESPONSE="$(curl -fsS --max-time 15 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SECRET" \
  --data-binary "$PAYLOAD" \
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
except (TypeError, ValueError):
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
