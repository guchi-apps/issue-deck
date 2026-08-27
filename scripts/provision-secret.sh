#!/usr/bin/env bash
# シークレットの発行から本番反映までを1本で通す（#1874）。
#
#   値を用意 → 1Passwordへ書く → GitHubのsecretへ同期 → デプロイを起こす → 反映を確かめる
#
# **なぜ要るか。** これまでこの一連の作業は`71.manual-step`のIssueとして起票され、人が手で
# 実行していた。エージェントが代行できなかったのは**1Passwordへ書く権限が無かった**ためで、
# 前後の工程（生成・同期・デプロイ）はすべて自動化済みだった。書き込み権限を持つサービス
# アカウントを別に用意したことで、通しで実行できるようになった（#1874）。
#
# **secretをGitHubへ登録しただけでは本番に入らない。** 本番の`.env`へ書くのはデプロイの
# `update_env`で、値を足しただけではコード変更が無く`develop`→`main`のリリースPRを作れない
# ため、手順がそこで止まる（guchi-apps/ops-dashboard#90・guchi-apps/aide#65が実際にこの形で
# 止まっていた）。そのため**デプロイの起動までをこのスクリプトの責務に含める**。
#
# 使い方:
#   scripts/provision-secret.sh --repo guchi-apps/subscription-lists --key INTERNAL_API_KEY --generate base64-32
#   scripts/provision-secret.sh --repo guchi-apps/aide --key AIDE_READ_SECRET --generate hex32 --dry-run
#   printf '%s' "$値" | scripts/provision-secret.sh --repo guchi-apps/aide --key ZAIM_EMAIL --from-stdin
#   scripts/provision-secret.sh --repo guchi-apps/aide --key AIDE_OPS_DASHBOARD_TOKEN \
#     --copy-from "op://apps/ops-dashboard/ops-api-token"
#   # 1Passwordへ値を入れ済みで、同期だけを行う（organizationの共通値）
#   scripts/provision-secret.sh --repo guchi-apps/issue-deck --key SIGNALY_RELEASE_WEBHOOK_URL \
#     --manifest .github/org-secrets-manifest.tsv --sync-only
#
# オプション:
#   --repo <owner/repo>    対象リポジトリ（必須）
#   --key <KEY>            マニフェスト上のキー名（必須）
#   --generate <種別>      値を生成する。hex32 / hex64 / base64-32
#   --from-stdin           標準入力から値を読む（外部サービスで発行した値を渡す用）
#   --copy-from <op://…>   既存の値をコピーする
#   --field-type <型>      1Password側のフィールド型。password（既定）/ text / url
#   --manifest <パス>      対応表のパス（既定 .github/secrets-manifest.tsv）。organizationの
#                          共通値は .github/org-secrets-manifest.tsv を指定する
#   --ref <ブランチ>       マニフェストを読むブランチ（既定 develop）
#   --dry-run              書き込み・同期・デプロイを行わず、何をするかだけ出す
#   --no-deploy            同期までで止める（デプロイを起こさない）
#   --no-wait              デプロイの完了を待たない
#   --force                1Password側に既に値がある場合も上書きする
#
# 前提:
#   `~/.config/issue-deck/op-writer.env` に書き込み権限つきサービスアカウントのトークンを
#   `OP_SERVICE_ACCOUNT_TOKEN=…` の形で置く（`apps:read_items,write_items`）。
#   **GitHubのsecretには登録せず、常時exportもしない**——常時exportすると、個人アカウントで
#   `op signin`してもサービスアカウントが優先され、opの書き込みが全部失敗する
#   （guchi-apps/docs の knowledge/common-gotchas.md）。このスクリプトは実行中だけ読み込む。
#
# **値は一切出力しない。** 生成した値も、読んだ値も、長さ以外は表示しない。
set -euo pipefail

WRITER_ENV="${OP_WRITER_ENV:-$HOME/.config/issue-deck/op-writer.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync-github-secrets.sh"

REPO=""
KEY=""
GENERATE=""
FROM_STDIN=false
COPY_FROM=""
FIELD_TYPE="password"
REF="develop"
MANIFEST_PATH=".github/secrets-manifest.tsv"
DRY_RUN=false
DEPLOY=true
WAIT=true
FORCE=false
SYNC_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --generate) GENERATE="$2"; shift 2 ;;
    --from-stdin) FROM_STDIN=true; shift ;;
    --copy-from) COPY_FROM="$2"; shift 2 ;;
    --field-type) FIELD_TYPE="$2"; shift 2 ;;
    --manifest) MANIFEST_PATH="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-deploy) DEPLOY=false; shift ;;
    --no-wait) WAIT=false; shift ;;
    --force) FORCE=true; shift ;;
    --sync-only) SYNC_ONLY=true; shift ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$REPO" ]] || { echo "--repo は必須です" >&2; exit 1; }
[[ -n "$KEY" ]] || { echo "--key は必須です" >&2; exit 1; }

# 値の出どころは1つだけ選ぶ。取り違えると意図しない値を本番へ入れてしまう
sources=0
[[ -n "$GENERATE" ]] && sources=$((sources + 1))
[[ "$FROM_STDIN" == true ]] && sources=$((sources + 1))
[[ -n "$COPY_FROM" ]] && sources=$((sources + 1))
if [[ "$SYNC_ONLY" == true ]]; then
  # 既に1Passwordに値がある項目（実装時に登録済み・別Issueで発行済みなど）は、
  # 生成せずに同期とデプロイだけを行う。値を作り直すと既存の利用側が壊れる
  if ((sources != 0)); then
    echo "--sync-only では値の出どころを指定できません（1Passwordの既存値をそのまま使います）" >&2
    exit 1
  fi
elif ((sources != 1)); then
  echo "値の出どころを1つだけ指定してください（--generate / --from-stdin / --copy-from / --sync-only）" >&2
  exit 1
fi

case "$FIELD_TYPE" in
  password | text | url) ;;
  *) echo "--field-type は password / text / url のいずれかです: $FIELD_TYPE" >&2; exit 1 ;;
esac

command -v op >/dev/null || { echo "1Password CLI (op) がありません" >&2; exit 1; }
command -v gh >/dev/null || { echo "GitHub CLI (gh) がありません" >&2; exit 1; }
[[ -f "$SYNC_SCRIPT" ]] || { echo "同期スクリプトが見つかりません: $SYNC_SCRIPT" >&2; exit 1; }
[[ -r "$WRITER_ENV" ]] || {
  echo "書き込み用トークンがありません: $WRITER_ENV" >&2
  echo "  op service-account create \"apps-writer\" --vault \"apps:read_items,write_items\" --raw" >&2
  exit 1
}

WORK="$(mktemp -d -t provision-secret.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. マニフェストから op:// 参照を引く -------------------------------------
#
# **参照先を引数で受けない。** マニフェスト（`.github/secrets-manifest.tsv`）が唯一の正で、
# 実装PRの時点で行が入っている。引数で受けると二重管理になり、綴りの違いに気付けない。
MANIFEST="$WORK/manifest.tsv"
if ! gh api "repos/$REPO/contents/$MANIFEST_PATH?ref=$REF" \
  -H "Accept: application/vnd.github.raw" > "$MANIFEST" 2>/dev/null; then
  echo "マニフェストを取得できません: $REPO $MANIFEST_PATH ($REF)" >&2
  exit 1
fi

line="$(awk -F'\t' -v k="$KEY" '$1 == k { print; exit }' "$MANIFEST")"
if [[ -z "$line" ]]; then
  echo "マニフェストに $KEY の行がありません: $REPO $MANIFEST_PATH ($REF)" >&2
  echo "**先に実装側のPRでマニフェストへ行を追加してください。** ここで足すと、コードが" >&2
  echo "その値を読んでいない状態でsecretだけが増える。" >&2
  exit 1
fi

IFS=$'\t' read -r _ scope kind gh_name source <<< "$line"

if [[ "$scope" == "inherit" ]]; then
  echo "$KEY は organization の $gh_name を継承する項目です。リポジトリ側では発行しません。" >&2
  exit 1
fi
if [[ -z "$source" || "$source" == "-" ]]; then
  echo "$KEY に op:// 参照がありません（source=$source）" >&2
  exit 1
fi
if [[ "$source" != op://* ]]; then
  echo "op:// 形式ではありません: $source" >&2
  exit 1
fi
if [[ "$source" == *\?* ]]; then
  # ?ssh-format=openssh のような変換指定付きは、書き戻す形が一意に決まらない
  echo "変換指定つきの参照には対応していません（手で登録してください）: $source" >&2
  exit 1
fi

ref_body="${source#op://}"
IFS='/' read -r op_vault op_item op_field <<< "$ref_body"
if [[ -z "$op_vault" || -z "$op_item" || -z "$op_field" ]]; then
  echo "op:// 参照を vault/item/field に分解できません: $source" >&2
  exit 1
fi

echo "対象      : $REPO"
echo "キー      : $KEY -> GitHub $kind $gh_name"
echo "1Password : $op_vault / $op_item / $op_field（$FIELD_TYPE）"

# organizationの共通値（`--manifest .github/org-secrets-manifest.tsv`）は、どれか1つの
# リポジトリのデプロイでは本番へ行き渡らない（参照している全リポジトリのデプロイが要る）。
# ここは同期までで止め、反映は各リポジトリのデプロイに任せる
if [[ "$scope" == "org" && "$DEPLOY" == true ]]; then
  echo "organizationの共通値のため、デプロイは起こしません（参照する各リポジトリのデプロイで反映されます）"
  DEPLOY=false
fi

# --- 2. 値を用意する ----------------------------------------------------------
load_writer() { set -a; . "$WRITER_ENV"; set +a; }

value=""
origin_desc=""
if [[ "$SYNC_ONLY" == true ]]; then
  : # 値は作らない。既存値を後段で確かめる
elif [[ -n "$GENERATE" ]]; then
  case "$GENERATE" in
    hex32) value="$(openssl rand -hex 32)" ;;
    hex64) value="$(openssl rand -hex 64)" ;;
    base64-32) value="$(openssl rand -base64 32)" ;;
    *) echo "--generate は hex32 / hex64 / base64-32 のいずれかです: $GENERATE" >&2; exit 1 ;;
  esac
  origin_desc="生成（$GENERATE）"
elif [[ "$FROM_STDIN" == true ]]; then
  value="$(cat)"
  # 貼り付け時の改行を落とす。末尾の改行が入ったまま同期すると、比較や認証が静かに失敗する
  value="${value%$'\n'}"
  origin_desc="標準入力"
else
  value="$( load_writer; op read "$COPY_FROM" 2>/dev/null )" || {
    echo "コピー元を読めません: $COPY_FROM" >&2; exit 1; }
  origin_desc="コピー（$COPY_FROM）"
fi

if [[ "$SYNC_ONLY" != true ]]; then
  [[ -n "$value" ]] || { echo "値が空です（出どころ: $origin_desc）" >&2; exit 1; }
  echo "値        : $origin_desc・${#value}文字"
fi

# --- 3. 既存の値を確かめる ----------------------------------------------------
existing="$( load_writer; op read "$source" 2>/dev/null )" || existing=""
if [[ "$SYNC_ONLY" == true ]]; then
  [[ -n "$existing" ]] || {
    echo "1Passwordに値がありません: $source" >&2
    echo "--sync-only は既に値がある項目にだけ使えます。新規発行なら --generate 等を指定してください。" >&2
    exit 1; }
  echo "値        : 1Passwordの既存値・${#existing}文字（作り直しません）"
elif [[ -n "$existing" && "$FORCE" != true ]]; then
  echo "既に値が入っています（${#existing}文字）。" >&2
  echo "  そのまま同期するだけなら --sync-only、作り直すなら --force を付けてください。" >&2
  exit 1
fi

if [[ "$DRY_RUN" == true ]]; then
  echo
  echo "dry-run のためここで終了します。実行時は次を行います:"
  [[ "$SYNC_ONLY" == true ]] || echo "  1. op item edit \"$op_item\" --vault $op_vault \"$op_field[$FIELD_TYPE]=***\""
  echo "  2. sync-github-secrets.sh --repo $REPO --only $KEY"
  [[ "$DEPLOY" == true ]] && echo "  3. gh workflow run deploy.yml --repo $REPO --ref main"
  exit 0
fi

# --- 4. 1Passwordへ書く -------------------------------------------------------
if [[ "$SYNC_ONLY" == true ]]; then
  echo
  echo "1Passwordの既存値を使います（書き込みは行いません）"
else
echo
echo "1Passwordへ書き込みます..."
( load_writer; op item edit "$op_item" --vault "$op_vault" "$op_field[$FIELD_TYPE]=$value" >/dev/null ) || {
  echo "1Passwordへの書き込みに失敗しました。トークンに write_items があるか確認してください。" >&2
  exit 1; }

written="$( load_writer; op read "$source" 2>/dev/null )" || written=""
if [[ "$written" != "$value" ]]; then
  echo "書き込んだ値を読み直せません（$op_field）。手で確認してください。" >&2
  exit 1
fi
echo "  書き込みを確認しました（${#written}文字）"
unset written
fi
unset value existing

# --- 5. GitHubへ同期する ------------------------------------------------------
echo
echo "GitHubのsecretへ同期します..."
( load_writer; "$SYNC_SCRIPT" --repo "$REPO" --manifest "$MANIFEST" --only "$KEY" )

# --- 6. デプロイを起こす ------------------------------------------------------
#
# **ここまでやらないと本番の`.env`に入らない。** `update_env`が動くのはデプロイのときだけで、
# 値を足しただけではリリースPRを作れず手順が止まる（冒頭のコメント参照）。
if [[ "$DEPLOY" != true ]]; then
  echo
  echo "--no-deploy のため、本番へは反映していません。反映するには:"
  echo "  gh workflow run deploy.yml --repo $REPO --ref main"
  exit 0
fi

echo
echo "本番へ反映します（deploy.yml）..."
gh workflow run deploy.yml --repo "$REPO" --ref main
sleep 8
run_id="$(gh run list --repo "$REPO" --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "  run: https://github.com/$REPO/actions/runs/$run_id"

if [[ "$WAIT" != true ]]; then
  echo "--no-wait のため完了は待ちません。"
  exit 0
fi

gh run watch "$run_id" --repo "$REPO" --interval 20 >/dev/null 2>&1 || true
conclusion="$(gh run view "$run_id" --repo "$REPO" --json conclusion --jq '.conclusion')"
echo "  デプロイ: $conclusion"
[[ "$conclusion" == "success" ]] || exit 1

echo
echo "完了しました。**アプリ側の疎通は別途確かめてください**（secretが入っていることと、"
echo "そのアプリが期待どおり動くことは別）。"
