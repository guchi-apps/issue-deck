#!/usr/bin/env bash
# issue-deckへ貼られた画像を、AIが読めるようにローカルへ保存する（#2967）。
#
# 画像の配信（`GET /api/issues/images/<UUID>`）は、URLが公開リポジトリのIssue本文に載るため
# **ログイン中の本人か共有シークレットを持つ呼び出し元にしか返さない。** AIはブラウザの
# Cookieを持たないので、このスクリプトでシークレットを付けて取得し、保存先を`Read`で開く。
#
# 呼び出し元は2つ。
#
#   - ローカルセッション（実装・横断質問）: 引数にURLを渡す。宛先と鍵はpollerと同じ
#     `~/.config/issue-deck/dispatch.env`の`APP_BASE_URL`・`DISPATCH_SECRET`
#   - 無人実行（`.github/workflows/reusable-issue-dispatch.yml`）: Claudeステップの前に
#     Issue本文・コメントを標準入力で渡す。宛先と鍵は`ISSUE_DECK_IMAGE_BASE_URL`・
#     `ISSUE_DECK_IMAGE_SECRET`（`APP_BASE_URL`・`PROGRESS_REPORT_SECRET`を入れる）。
#     **Claudeの環境変数へ鍵を渡さないために、取得をClaudeの外で済ませている**
#
# **鍵を送る先は常に設定の`APP_BASE_URL`に固定する。** URLからはファイル名だけを取り出し、
# URLのホストへは接続しない。本文に紛れ込んだ別ホストのURL（`https://attacker/api/issues/images/…`）
# へ鍵を付けて送ってしまうのを防ぐため。
#
# 鍵はコマンドライン引数に載せない（`ps`から見えるため）。`curl --header @-`で標準入力から渡す。

set -euo pipefail

CONFIG_FILE="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
OUT_DIR="${ISSUE_DECK_IMAGE_DIR:-${TMPDIR:-/tmp}/issue-deck-images}"

usage() {
  cat >&2 <<'EOF'
Usage: fetch-issue-images.sh [--out <DIR>] <画像URL>...
       fetch-issue-images.sh [--out <DIR>] -   # 標準入力の文章から画像URLを拾う

issue-deckの画像（.../api/issues/images/<UUID>.<拡張子>）を保存し、保存先のパスを1行ずつ出します。
保存したファイルはReadツールで開いてください。
終了コード: 0=すべて保存（対象が0件も含む）、1=使い方・設定の誤り、2=取得に失敗したものがある
EOF
}

# `src/lib/uploaded-images.ts`の`UPLOADED_IMAGE_FILENAME_SOURCE`と同じ形。
# ここで拾えないものは配信側でも404になるので、緩める必要は無い。
FILENAME_PATTERN='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp|svg)'

sources=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 ]] || { usage; exit 1; }
      OUT_DIR="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      sources+=("$1")
      shift
      ;;
  esac
done
[[ ${#sources[@]} -gt 0 ]] || { usage; exit 1; }

dispatch_env_value() {
  local name="$1"
  if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    (set +eu; source "$CONFIG_FILE" >/dev/null 2>&1; printf '%s' "${!name:-}")
    return 0
  fi
  printf '%s' "${!name:-}"
}

BASE_URL="${ISSUE_DECK_IMAGE_BASE_URL:-}"
SECRET="${ISSUE_DECK_IMAGE_SECRET:-}"
[[ -n "$BASE_URL" ]] || BASE_URL="$(dispatch_env_value APP_BASE_URL)"
[[ -n "$SECRET" ]] || SECRET="$(dispatch_env_value DISPATCH_SECRET)"
if [[ -z "$BASE_URL" || -z "$SECRET" ]]; then
  echo "Error: 画像の取得先（APP_BASE_URL）か鍵（DISPATCH_SECRET）が見つかりません（$CONFIG_FILE）" >&2
  echo "       サブPCでは ~/.config/issue-deck/dispatch.env に両方を置いてください（deploy/subpc/dispatch.env.example 参照）。" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

text=""
for source in "${sources[@]}"; do
  if [[ "$source" == "-" ]]; then
    text+="$(cat)"$'\n'
  else
    text+="$source"$'\n'
  fi
done

# `/api/issues/images/`の直後に来るファイル名だけを拾う（同じ画像が何度出ても1回にする）
mapfile -t filenames < <(
  printf '%s' "$text" |
    grep -oE "/api/issues/images/$FILENAME_PATTERN" |
    sed 's#^/api/issues/images/##' |
    sort -u || true
)

if [[ ${#filenames[@]} -eq 0 ]]; then
  echo "issue-deckの画像URLは見つかりませんでした。" >&2
  exit 0
fi

mkdir -p "$OUT_DIR"
failed=0
for filename in "${filenames[@]}"; do
  dest="$OUT_DIR/$filename"
  if [[ -s "$dest" ]]; then
    printf '%s\n' "$dest"
    continue
  fi
  status="$(printf 'Authorization: Bearer %s\n' "$SECRET" |
    curl --silent --show-error --max-time 30 \
      --header @- \
      --output "$dest.part" \
      --write-out '%{http_code}' \
      "$BASE_URL/api/issues/images/$filename")" || status="000"
  if [[ "$status" == "200" ]]; then
    mv "$dest.part" "$dest"
    printf '%s\n' "$dest"
  else
    rm -f "$dest.part"
    echo "Warning: $filename を取得できませんでした（HTTP $status）" >&2
    failed=1
  fi
done

[[ "$failed" -eq 0 ]] || exit 2
