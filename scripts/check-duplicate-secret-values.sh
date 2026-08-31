#!/usr/bin/env bash
# 同じ値が1Passwordの複数フィールドに入っていないかを検査する（#2624）。
#
# **なぜ要るか。** アプリ間の認証（AIDEが他アプリのAPIを叩くときのトークンなど）は、双方が
# 同じ値を持つことで成立する。この「同じ値」を提供側・利用側それぞれのアイテムへ**別々に
# 入れてしまう**と、片方だけ入れ替えた時点で連携が黙って止まる。実際に#2624の調査時点で
# 5組が複製されており、うち1組（`AIDE_RESEARCH_DESK_TOKEN`）は利用側のフィールドが作られない
# まま参照だけが残り、GitHubのsecretも未登録で連携が未配線だった。
#
# 正しい形は**値を検証する側（提供側）のアイテムを唯一の正とし、利用側のマニフェストがその
# `op://`をそのまま参照する**こと。規約は docs/cross-repo-setup-guide.md
# 「アプリ間で共有する認証値は提供側の`op://`を参照する」を参照。
#
# 見るのは2つ。
#   1. **値の複製** … 同じ値が2つ以上のフィールドに入っている（どちらか片方へ寄せる）
#   2. **参照先の不在** … マニフェストの`op://`が指すアイテム・フィールドが存在しない
#
# **値の性質上一致するもの**（本人のメールアドレス・VAPIDのsubjectなど）は寄せる先が無いため、
# `.github/duplicate-secret-allowlist.txt`へ書いて報告から外す。資格情報は書かない。
#
# 使い方:
#   scripts/check-duplicate-secret-values.sh
#   scripts/check-duplicate-secret-values.sh --repos aide,dayspan   # 参照元の収集を絞る
#
# オプション:
#   --org <organization>   マニフェストを集めるorganization（既定 guchi-apps）
#   --vault <ボールト>     検査する1Passwordのボールト（既定 apps）
#   --repos <a,b,c>        参照元として読むリポジトリ（既定 アーカイブ以外のすべて）
#   --ref <ブランチ>       マニフェストを読むブランチ（既定 各リポジトリのデフォルトブランチ）
#   --allowlist <パス>     一致していてよい組み合わせの表（既定 .github/duplicate-secret-allowlist.txt）
#
# 前提:
#   `op`が`apps`ボールトを読めること。サブPCでは読み取り専用のサービスアカウントが
#   `~/.profile.local`から常時exportされているため、`op signin`は要らない。
#   ボールト全体を1回ずつ読むため、消費するのは**アイテム数＋1**リクエスト（27件前後）と、
#   不在の候補になったフィールドの件数ぶん。フィールドごとに`op read`すると参照の数だけ
#   （実測250件前後）使うため、アイテム単位で読む。
#   `sync-github-secrets.sh`と違い、GitHubへは何も書かない。
#
# **値もハッシュも一切出力しない。** 突き合わせはSHA-256で行い、画面に出すのは`op://`の
# パスと、それを参照しているリポジトリ・キー名だけ。
#
# 終了コード: 複製・不在のどちらかが1件でもあれば1、無ければ0。
set -euo pipefail

ORG="${ORG:-guchi-apps}"
VAULT="apps"
REPOS=""
REF=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWLIST="$SCRIPT_DIR/../.github/duplicate-secret-allowlist.txt"
# 短い値は偶然一致する（ポート番号・`true`など）。資格情報としての複製だけを拾うため、
# これより短い値は突き合わせの対象にしない
MIN_LENGTH=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --vault) VAULT="$2"; shift 2 ;;
    --repos) REPOS="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --allowlist) ALLOWLIST="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; exit 2 ;;
  esac
done

command -v op >/dev/null || { echo "1Password CLI (op) がありません" >&2; exit 2; }
command -v gh >/dev/null || { echo "GitHub CLI (gh) がありません" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq がありません" >&2; exit 2; }

WORK="$(mktemp -d -t check-dup-secrets.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. 参照元（各リポジトリのマニフェスト）を集める --------------------------
#
# 参照は`.github/secrets-manifest.tsv`のSOURCE列だけを見る。`inherit`の行はSOURCEが「-」で、
# 値の正はorganization側の対応表にあるため、ここでは参照として数えない。
if [[ -n "$REPOS" ]]; then
  tr ',' '\n' <<< "$REPOS" | sed '/^$/d' > "$WORK/repos.txt"
else
  gh repo list "$ORG" --no-archived --limit 200 --json name --jq '.[].name' > "$WORK/repos.txt"
fi

: > "$WORK/refs.tsv"   # op://参照 <TAB> リポジトリ <TAB> キー
manifest_count=0
while read -r repo; do
  [[ -n "$repo" ]] || continue
  path="repos/$ORG/$repo/contents/.github/secrets-manifest.tsv"
  [[ -n "$REF" ]] && path="$path?ref=$REF"
  gh api "$path" -H "Accept: application/vnd.github.raw" > "$WORK/manifest.tsv" 2>/dev/null || continue
  manifest_count=$((manifest_count + 1))
  awk -F'\t' -v repo="$ORG/$repo" '
    /^[[:space:]]*#/ { next }
    NF >= 5 && $5 ~ /^op:\/\// { print $5 "\t" repo "\t" $1 }
  ' "$WORK/manifest.tsv" >> "$WORK/refs.tsv"
done < "$WORK/repos.txt"

# --- 2. ボールトの値をハッシュにする ------------------------------------------
#
# **値はここでしか触らず、ファイルにも変数にも残さない。** アイテム単位で1回だけ読むのは、
# フィールドごとに`op read`すると参照の数だけリクエストを使うため（実測で250件前後あり、
# 1Passwordの日次1,000リクエストの枠を1回の検査で1/4使ってしまう）。
: > "$WORK/hashes.tsv"    # op://パス <TAB> 値のハッシュ（短い値は入らない）
: > "$WORK/present.tsv"  # 値が入っているフィールドのop://パス（不在の判定に使う）
op item list --vault "$VAULT" --format json | jq -r '.[] | .id + "\t" + .title' > "$WORK/items.tsv"
item_count=0
while IFS=$'\t' read -r id title; do
  [[ -n "$id" ]] || continue
  item_count=$((item_count + 1))
  op item get "$id" --vault "$VAULT" --format json --reveal 2>/dev/null \
    | jq -r '.fields[]? | select(.value != null and .value != "") | (.label // .id) + "\t" + (.value | @base64)' \
    | while IFS=$'\t' read -r label encoded; do
        path="op://$VAULT/$title/$label"
        echo "$path" >> "$WORK/present.tsv"
        decoded="$(base64 -d <<< "$encoded")"
        [[ "${#decoded}" -ge "$MIN_LENGTH" ]] || continue
        printf '%s\t%s\n' "$path" "$(printf '%s' "$decoded" | sha256sum | cut -d' ' -f1)" >> "$WORK/hashes.tsv"
      done
done < "$WORK/items.tsv"
sort -u -o "$WORK/present.tsv" "$WORK/present.tsv"

# --- 3. 参照元を引ける形にする ------------------------------------------------
#
# `?ssh-format=openssh`のような変換指定は、指しているフィールドは同じなので落として突き合わせる
refs_for() {
  awk -F'\t' -v target="$1" '{ sub(/\?.*$/, "", $1); if ($1 == target) print "    ← " $2 "（" $3 "）" }' \
    "$WORK/refs.tsv" | sort -u
}

# --- 4. 値が複製されているフィールドを報告する --------------------------------
dup_groups=0
allowed=0
# 許容表（`comm`で突き合わせるため整列させる）。コメント行と空行は読み飛ばす
if [[ -f "$ALLOWLIST" ]]; then
  grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" | LC_ALL=C sort -u > "$WORK/allowlist.txt"
else
  : > "$WORK/allowlist.txt"
fi
echo "== 値が複製されているフィールド"
while read -r hash; do
  [[ -n "$hash" ]] || continue
  # 同じアイテムに同名のフィールドが2つある（セクション違い）場合も同じ値として現れるが、
  # `op://`から見れば1か所なので複製ではない。パスを一意にしてから数える
  awk -F'\t' -v h="$hash" '$2 == h { print $1 }' "$WORK/hashes.tsv" | LC_ALL=C sort -u > "$WORK/group.txt"
  [[ "$(wc -l < "$WORK/group.txt")" -ge 2 ]] || continue
  # 許容表に載っているパスだけで構成されるグループは、値の性質上一致するもの（許可メールなど）
  if [[ "$(LC_ALL=C comm -23 "$WORK/group.txt" "$WORK/allowlist.txt" | wc -l)" -eq 0 ]]; then
    allowed=$((allowed + 1))
    continue
  fi
  dup_groups=$((dup_groups + 1))
  echo "  複製${dup_groups}"
  while read -r path; do
    echo "    $path"
    refs_for "$path"
  done < "$WORK/group.txt"
done < <(cut -f2 "$WORK/hashes.tsv" | sort | uniq -d)
[[ "$dup_groups" -eq 0 ]] && echo "  なし"

# --- 5. 参照先が実在しないものを報告する --------------------------------------
missing=0
echo "== 参照先が実在しないフィールド"
while read -r path; do
  [[ -n "$path" ]] || continue
  # 突き合わせから外した短い値も`present.tsv`には入っているので、ここを不在と誤って報告しない
  grep -Fxq "$path" "$WORK/present.tsv" && continue
  # SSH鍵の`private_key`のような組み込みフィールドは`op item get`のフィールド一覧に別の名前で
  # 出るため、一覧に無い＝不在とは言い切れない。**候補になったものだけ**を実際に読んで確かめる
  # （変換指定つきの参照はマニフェストの元の形で読む）
  original="$(awk -F'\t' -v p="$path" '{ o = $1; sub(/\?.*$/, "", o); if (o == p) { print $1; exit } }' "$WORK/refs.tsv")"
  op read "${original:-$path}" >/dev/null 2>&1 && continue
  missing=$((missing + 1))
  echo "    $path"
  refs_for "$path"
done < <(cut -f1 "$WORK/refs.tsv" | sed 's/?.*$//' | sort -u | grep "^op://$VAULT/" || true)
[[ "$missing" -eq 0 ]] && echo "  なし"

ref_count="$(wc -l < "$WORK/refs.tsv" | tr -d ' ')"
echo "== 集計"
echo "マニフェスト=$manifest_count 参照=$ref_count アイテム=$item_count 複製=$dup_groups 許容=$allowed 不在=$missing"

[[ "$dup_groups" -eq 0 && "$missing" -eq 0 ]]
