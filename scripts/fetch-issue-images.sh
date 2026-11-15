#!/usr/bin/env bash
# issue-deckへ貼られた画像を、AIが読めるようにローカルへ保存する（#2967）。
#
# 画像の配信（`GET /api/issues/images/<UUID>.<拡張子>`）は、URLが公開リポジトリのIssue本文に載るため
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
拡張子が欠けたURL（.../api/issues/images/<UUID>）も受け付け、配信側にある拡張子を探して取得します。
保存したファイルはReadツールで開いてください。
終了コード: 0=すべて保存（対象が0件も含む）、1=使い方・設定の誤り、
            2=取得に失敗したもの・画像URLらしいのに読み取れなかったものがある
EOF
}

# `src/lib/uploaded-images.ts`の`UPLOADED_IMAGE_FILENAME_SOURCE`と同じ形。
# ここで拾えないものは配信側でも404になるので、緩める必要は無い。
#
# **拡張子は省略されていても拾う**（#5425）。エージェントは本文のURLを写すときに`.png`を
# 落とすことがあり（案内文の`.../images/<UUID>`に引きずられる）、拡張子必須のままだと
# 「画像URLは見つかりませんでした」で終了コード0になり、画像を見ないまま作業が進んでいた。
# 拡張子の無いものは、配信側が受け付ける拡張子（`EXTENSIONS`）を順に試して取得する。
# 鍵を送る先は従来どおり`APP_BASE_URL`だけで、試すのはファイル名の末尾だけ。
UUID_PATTERN='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
EXTENSIONS=(png jpg webp gif svg)
FILENAME_PATTERN="$UUID_PATTERN"'(\.(png|jpg|gif|webp|svg))?'

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

# `/api/issues/images/`の直後に来るファイル名だけを拾う（同じ画像が何度出ても1回にする）。
# 拡張子付きと拡張子なしの同じUUIDが両方出たときは、拡張子付きだけを残す。
mapfile -t filenames < <(
  printf '%s' "$text" |
    grep -oE "/api/issues/images/$FILENAME_PATTERN" |
    sed 's#^/api/issues/images/##' |
    sort -u |
    awk -F. '{ if ($2 != "") { print; seen[$1] = 1 } else bare[$1] = 1 }
      END { for (u in bare) if (!(u in seen)) print u }' |
    sort -u || true
)

if [[ ${#filenames[@]} -eq 0 ]]; then
  # **URLの一部が見えているのに拾えないときは失敗として返す**（#5425）。終了コード0で
  # 「見つかりませんでした」と返すと、呼び出したエージェントは画像が無いものとして先へ進む。
  if printf '%s' "$text" | grep -q "/api/issues/images/"; then
    echo "Error: issue-deckの画像URLらしき文字列はありますが、ファイル名（<UUID>.<拡張子>）を読み取れませんでした。" >&2
    echo "       本文に書かれているURLを省略せず、そのまま渡してください（例: gh issue view <番号> --json body,comments --jq '.body, .comments[].body' | $0 -）。" >&2
    exit 2
  fi
  echo "issue-deckの画像URLは見つかりませんでした。" >&2
  exit 0
fi

mkdir -p "$OUT_DIR"

# 1枚取得して保存し、HTTPステータスを返す（200なら`$dest`へ置いてある）
download() {
  local filename="$1" dest="$2" status
  status="$(printf 'Authorization: Bearer %s\n' "$SECRET" |
    curl --silent --show-error --max-time 30 \
      --header @- \
      --output "$dest.part" \
      --write-out '%{http_code}' \
      "$BASE_URL/api/issues/images/$filename")" || status="000"
  if [[ "$status" == "200" ]]; then
    mv "$dest.part" "$dest"
  else
    rm -f "$dest.part"
  fi
  printf '%s' "$status"
}

failed=0
for filename in "${filenames[@]}"; do
  if [[ "$filename" == *.* ]]; then
    candidates=("$filename")
  else
    candidates=()
    for extension in "${EXTENSIONS[@]}"; do candidates+=("$filename.$extension"); done
  fi

  saved=""
  status=""
  for candidate in "${candidates[@]}"; do
    dest="$OUT_DIR/$candidate"
    if [[ -s "$dest" ]]; then
      saved="$dest"
      break
    fi
    status="$(download "$candidate" "$dest")"
    if [[ "$status" == "200" ]]; then
      saved="$dest"
      break
    fi
    # 404（その拡張子では存在しない）だけ次の拡張子を試す。認証・通信の失敗は何度試しても同じ
    [[ "$status" == "404" ]] || break
  done

  if [[ -n "$saved" ]]; then
    printf '%s\n' "$saved"
  else
    echo "Warning: $filename を取得できませんでした（HTTP $status）" >&2
    failed=1
  fi
done

[[ "$failed" -eq 0 ]] || exit 2
