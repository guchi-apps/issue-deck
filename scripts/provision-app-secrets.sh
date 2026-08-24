#!/usr/bin/env bash
# 立ち上げで決まった値を1Passwordのアイテムへ入れ、GitHubのrepo secretへ同期する（#2249）。
#
#   値を渡す → 1Passwordのアイテムを作る／足りないフィールドだけ埋める
#           → GitHubのsecretへ同期 → repo secretの件数を確かめる
#
# **なぜ要るか。** 新規アプリの立ち上げ（#2188）が起票する手作業Issueは、1Passwordの登録を
# `db-name = app_aide_bot / ci-webhook-url（Signaly）/ target-dir = /apps/aide-bot` という
# **フィールド名の羅列**で書いていた。実行できるコマンドになっていないため未登録のまま初回の
# 本番デプロイが走り、`DB_NAME: DB_NAME is required` で失敗した（`guchi-apps/aide-bot#4`）。
# 立ち上げが決めた値のうち機械的に定まるもの（配置先・DB名・許可メール）は、人が読み替えずに
# そのまま流せる。
#
# **`provision-secret.sh`（#1874）とは役割が違う。** あちらは**マニフェストに行がある1キー**を
# 発行して本番へ反映するまでを通すもので、アイテムがまだ無い立ち上げでは使えない（そもそも
# マニフェストが無い）。こちらは**アイテムの新規作成と複数フィールドの一括投入**が役割で、
# デプロイは起こさない（立ち上げの時点では配置先もDBもまだ無く、起こしても失敗する）。
# 値を1件だけ差し替える・発行し直すときは、従来どおり `provision-secret.sh` を使う。
#
# **何度実行してもよい。** 既に値があるフィールドは触らない（`--force` で上書き）。実行の順序を
# 気にせず、Signalyのwebhook URLだけを後から足すこともできる。
#
# 使い方:
#   scripts/provision-app-secrets.sh --repo guchi-apps/kakei-report --db-name app_kakei_report
#   scripts/provision-app-secrets.sh --repo guchi-apps/kakei-report --copy-allowed-emails
#   scripts/provision-app-secrets.sh --repo guchi-apps/kakei-report \
#     --ci-webhook-url 'https://signaly.gucchii.com/webhook/xxxx'
#
# オプション:
#   --repo <owner/repo>       対象リポジトリ（必須）
#   --item <タイトル>         1Password側のアイテム名（既定: リポジトリ名）
#   --vault <ボールト>        既定 apps
#   --target-dir <パス>       実機の配置先（既定 /home/github-user/apps/<アイテム名>）
#   --no-target-dir           配置先を投入しない
#   --db-name <DB名>          MariaDBのデータベース名
#   --allowed-emails <値>     ログインを許可するGoogleアカウント（カンマ区切り）
#   --copy-allowed-emails     許可メールを既定のコピー元（下記）から写す
#   --allowed-emails-from <op://…>  コピー元を指定して写す
#   --ci-webhook-url <URL>    SignalyのWebhook URL（人がチャンネルを作ってから渡す）
#   --ref <ブランチ>          マニフェストを読むブランチ（既定 develop）
#   --no-sync                 1Passwordへ入れるだけで、GitHubへは同期しない
#   --dry-run                 何もせず、何をするかだけ出す
#   --force                   既に値があるフィールドも上書きする
#
# 前提:
#   `~/.config/issue-deck/op-writer.env` に書き込み権限つきサービスアカウントのトークンを
#   `OP_SERVICE_ACCOUNT_TOKEN=…` の形で置く（`apps:read_items,write_items`）。
#   **常時exportしない**——個人アカウントで `op signin` してもサービスアカウントが優先され、
#   opの書き込みが全部失敗する（`provision-secret.sh` の冒頭と同じ理由）。
#
# **値は一切出力しない。** 渡された値も、読んだ値も、長さ以外は表示しない。
set -euo pipefail

WRITER_ENV="${OP_WRITER_ENV:-$HOME/.config/issue-deck/op-writer.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync-github-secrets.sh"

REPO=""
ITEM=""
VAULT="apps"
CATEGORY="Secure Note"
TARGET_DIR=""
NO_TARGET_DIR=false
DB_NAME=""
ALLOWED_EMAILS=""
ALLOWED_EMAILS_FROM=""
# 許可メールの既定のコピー元。**同じ人しか使わない個人アプリなので、既存アプリの値がそのまま
# 正になる。** 参照を1か所に置くのは、立ち上げが起票するIssueの本文へ焼き込むと、コピー元の
# アイテム名が変わったときに過去のIssueごと直せなくなるため
DEFAULT_ALLOWED_EMAILS_FROM="op://apps/dayspan/allowed-google-emails"
CI_WEBHOOK_URL=""
REF="develop"
SYNC=true
DRY_RUN=false
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --item) ITEM="$2"; shift 2 ;;
    --vault) VAULT="$2"; shift 2 ;;
    --target-dir) TARGET_DIR="$2"; shift 2 ;;
    --no-target-dir) NO_TARGET_DIR=true; shift ;;
    --db-name) DB_NAME="$2"; shift 2 ;;
    --allowed-emails) ALLOWED_EMAILS="$2"; shift 2 ;;
    --copy-allowed-emails) ALLOWED_EMAILS_FROM="$DEFAULT_ALLOWED_EMAILS_FROM"; shift ;;
    --allowed-emails-from) ALLOWED_EMAILS_FROM="$2"; shift 2 ;;
    --ci-webhook-url) CI_WEBHOOK_URL="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --no-sync) SYNC=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force) FORCE=true; shift ;;
    -h|--help) sed -n '2,51p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$REPO" ]] || { echo "--repo は必須です" >&2; exit 1; }
[[ "$REPO" == */* ]] || { echo "--repo は owner/repo の形で指定してください: $REPO" >&2; exit 1; }
[[ -n "$ITEM" ]] || ITEM="${REPO#*/}"
if [[ "$NO_TARGET_DIR" != true && -z "$TARGET_DIR" ]]; then
  # 実機の配置先。`/apps/<name>` ではない（#2246。同じ立ち上げの中で2つのパスが混在していた）
  TARGET_DIR="/home/github-user/apps/$ITEM"
fi
if [[ -n "$ALLOWED_EMAILS" && -n "$ALLOWED_EMAILS_FROM" ]]; then
  echo "許可メールの出どころは1つだけ指定してください（--allowed-emails / --copy-allowed-emails / --allowed-emails-from）" >&2
  exit 1
fi

command -v op >/dev/null || { echo "1Password CLI (op) がありません" >&2; exit 1; }
command -v gh >/dev/null || { echo "GitHub CLI (gh) がありません" >&2; exit 1; }
[[ -f "$SYNC_SCRIPT" ]] || { echo "同期スクリプトが見つかりません: $SYNC_SCRIPT" >&2; exit 1; }
[[ -r "$WRITER_ENV" ]] || {
  echo "書き込み用トークンがありません: $WRITER_ENV" >&2
  echo "  op service-account create \"apps-writer\" --vault \"apps:read_items,write_items\" --raw" >&2
  exit 1
}

WORK="$(mktemp -d -t provision-app-secrets.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

load_writer() { set -a; . "$WRITER_ENV"; set +a; }

# --- 1. 投入するフィールドを決める --------------------------------------------
#
# **フィールド名は共有知識の規約に合わせる**（`op://apps/<app>/target-dir` など）。各アプリの
# `.github/secrets-manifest.tsv` がこの名前で参照しているので、変えると同期先が消える。
# セクション（`デプロイ.`）は1Passwordの画面での見出しで、`op read` の参照には現れない。
FIELD_NAMES=()
FIELD_SECTIONS=()
FIELD_TYPES=()
FIELD_VALUES=()

add_field() {
  FIELD_NAMES+=("$1")
  FIELD_SECTIONS+=("$2")
  FIELD_TYPES+=("$3")
  FIELD_VALUES+=("$4")
}

[[ "$NO_TARGET_DIR" == true ]] || add_field "target-dir" "デプロイ" "text" "$TARGET_DIR"
[[ -z "$DB_NAME" ]] || add_field "db-name" "DB" "text" "$DB_NAME"
if [[ -n "$ALLOWED_EMAILS_FROM" ]]; then
  [[ "$ALLOWED_EMAILS_FROM" == op://* ]] || {
    echo "--allowed-emails-from は op:// 形式で指定してください: $ALLOWED_EMAILS_FROM" >&2; exit 1; }
  copied="$( load_writer; op read "$ALLOWED_EMAILS_FROM" 2>/dev/null )" || copied=""
  [[ -n "$copied" ]] || { echo "コピー元を読めません: $ALLOWED_EMAILS_FROM" >&2; exit 1; }
  echo "許可メール: $ALLOWED_EMAILS_FROM からコピーします"
  ALLOWED_EMAILS="$copied"
  unset copied
fi
# 型は `email` ではなく `text`。許可メールはカンマ区切りで複数入ることがあり、
# `email` 型では1件しか入らない
[[ -z "$ALLOWED_EMAILS" ]] || add_field "allowed-google-emails" "認証" "text" "$ALLOWED_EMAILS"
[[ -z "$CI_WEBHOOK_URL" ]] || add_field "ci-webhook-url" "通知" "url" "$CI_WEBHOOK_URL"

((${#FIELD_NAMES[@]} > 0)) || { echo "投入する値がありません" >&2; exit 1; }

echo "対象      : $REPO"
echo "1Password : $VAULT / $ITEM"
for i in "${!FIELD_NAMES[@]}"; do
  echo "  ${FIELD_NAMES[$i]}（${FIELD_TYPES[$i]}）: ${#FIELD_VALUES[$i]}文字"
done

# --- 2. 既にある値を確かめる --------------------------------------------------
#
# **入っている値は触らない。** 立ち上げの手順は順序を選ばず何度も実行されうるので、
# 上書きを既定にすると、後から人が直した値を機械的な既定値へ戻してしまう。
if ( load_writer; op item get "$ITEM" --vault "$VAULT" --format json >/dev/null 2>&1 ); then
  ITEM_EXISTS=true
else
  ITEM_EXISTS=false
fi
echo "アイテム  : $([[ "$ITEM_EXISTS" == true ]] && echo "既にあります（足りないフィールドだけ埋めます）" || echo "新規に作ります")"

WRITE_INDEXES=()
FILLED_FIELDS=()
for i in "${!FIELD_NAMES[@]}"; do
  field="${FIELD_NAMES[$i]}"
  existing=""
  if [[ "$ITEM_EXISTS" == true ]]; then
    existing="$( load_writer; op read "op://$VAULT/$ITEM/$field" 2>/dev/null )" || existing=""
  fi
  if [[ -n "$existing" && "$FORCE" != true ]]; then
    echo "  skip   $field（既に${#existing}文字入っています。作り直すなら --force）"
    FILLED_FIELDS+=("$field")
  else
    WRITE_INDEXES+=("$i")
    FILLED_FIELDS+=("$field")
  fi
  unset existing
done

if [[ "$DRY_RUN" == true ]]; then
  echo
  echo "dry-run のためここで終了します。実行時は次を行います:"
  if ((${#WRITE_INDEXES[@]} > 0)); then
    for i in "${WRITE_INDEXES[@]}"; do
      echo "  1Password: ${FIELD_SECTIONS[$i]}.${FIELD_NAMES[$i]}[${FIELD_TYPES[$i]}] を設定"
    done
  else
    echo "  1Password: 変更なし（すべて値が入っています）"
  fi
  [[ "$SYNC" == true ]] && echo "  GitHub   : $REPO のsecretへ同期し、件数を確かめる"
  exit 0
fi

# --- 3. 1Passwordへ書く -------------------------------------------------------
if ((${#WRITE_INDEXES[@]} > 0)); then
  assignments=()
  for i in "${WRITE_INDEXES[@]}"; do
    assignments+=("${FIELD_SECTIONS[$i]}.${FIELD_NAMES[$i]}[${FIELD_TYPES[$i]}]=${FIELD_VALUES[$i]}")
  done

  echo
  if [[ "$ITEM_EXISTS" == true ]]; then
    echo "1Passwordのアイテムへ書き込みます..."
    ( load_writer; op item edit "$ITEM" --vault "$VAULT" "${assignments[@]}" >/dev/null ) || {
      echo "1Passwordへの書き込みに失敗しました。トークンに write_items があるか確認してください。" >&2
      exit 1; }
  else
    echo "1Passwordへアイテムを作ります..."
    ( load_writer; op item create --vault "$VAULT" --category "$CATEGORY" --title "$ITEM" \
      "${assignments[@]}" >/dev/null ) || {
      echo "1Passwordでのアイテム作成に失敗しました。トークンに write_items があるか確認してください。" >&2
      exit 1; }
  fi
  unset assignments

  # 書いた値を読み直して突き合わせる。書けたつもりで空のまま進むと、同期が通っても本番で落ちる
  for i in "${WRITE_INDEXES[@]}"; do
    field="${FIELD_NAMES[$i]}"
    written="$( load_writer; op read "op://$VAULT/$ITEM/$field" 2>/dev/null )" || written=""
    if [[ "$written" != "${FIELD_VALUES[$i]}" ]]; then
      echo "書き込んだ値を読み直せません（$field）。手で確認してください。" >&2
      exit 1
    fi
    echo "  ok     $field（${#written}文字）"
    unset written
  done
else
  echo
  echo "1Passwordは変更しません（すべてのフィールドに値が入っています）"
fi
unset FIELD_VALUES

# --- 4. GitHubのsecretへ同期する ----------------------------------------------
if [[ "$SYNC" != true ]]; then
  echo
  echo "--no-sync のため、GitHubへは同期していません。"
  exit 0
fi

# **参照先を引数で受けない**（`provision-secret.sh` と同じ理由）。どのKEYがどのフィールドを
# 読むかの正はマニフェストで、ここで組み立てると綴りの違いに気付けない。
MANIFEST="$WORK/manifest.tsv"
if ! gh api "repos/$REPO/contents/.github/secrets-manifest.tsv?ref=$REF" \
  -H "Accept: application/vnd.github.raw" > "$MANIFEST" 2>/dev/null; then
  echo
  echo "$REPO（$REF）に .github/secrets-manifest.tsv がまだありません。"
  echo "**1Passwordへの登録は済んでいます。** 雛形（マニフェスト）が入った後に同じコマンドを"
  echo "もう一度実行すると、GitHubのsecretまで同期されます。"
  exit 0
fi

# マニフェストのうち、いま値が入っているフィールドを読む行だけを選ぶ。値の無いフィールドを
# 混ぜると同期が FAIL で返り、入れられた値まで失敗に見える
only=""
for field in "${FILLED_FIELDS[@]}"; do
  key="$(awk -F'\t' -v s="op://$VAULT/$ITEM/$field" '$1 !~ /^#/ && $5 == s { print $1; exit }' "$MANIFEST")"
  if [[ -z "$key" ]]; then
    echo "  skip   $field（マニフェストにこのフィールドを読む行がありません）"
    continue
  fi
  only="${only:+$only,}$key"
done

if [[ -z "$only" ]]; then
  echo
  echo "マニフェストに $VAULT/$ITEM を読む行がありません。同期する項目がないため終了します。"
  exit 0
fi

echo
echo "GitHubのsecretへ同期します（$only）..."
( load_writer; "$SYNC_SCRIPT" --repo "$REPO" --manifest "$MANIFEST" --only "$only" )

# --- 5. 入ったことを件数で確かめる --------------------------------------------
#
# 同期スクリプトの出力は「送った側」の記録でしかない。**GitHub側から引き直す**ことで、
# 名前の取り違えや権限不足で入っていなかった場合にここで気付ける。
echo
echo "$REPO のrepo secret:"
gh api "repos/$REPO/actions/secrets" --jq '"  総数: \(.total_count)件\n" + ([.secrets[].name] | sort | map("  - " + .) | join("\n"))'

echo
echo "完了しました。**この後の初回デプロイでは、配置先・DB・Apacheの用意も要ります**"
echo "（secretが入っていることと、そのアプリが動くことは別）。"
