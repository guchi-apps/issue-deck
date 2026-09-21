#!/usr/bin/env bash
# guchi-apps配下の非アーカイブ全リポジトリへ、共通GitHubラベルを冪等に同期する（#3237）。
#
# 正本は`.github/labels.json`。名前・説明・色の作成/更新に加えて、旧名から新名への
# 改名（rename API）と、新名が既にある場合のIssue付け替え＋旧ラベル削除を扱う。
# 体系・移行対応・手順は docs/label-scheme.md を参照。
#
# 使い方:
#   scripts/sync-labels.sh [dry-run|apply] [--org <org>] [--repo <owner/repo>]... [--manifest <path>]
#
#   dry-run（既定） 変更対象と件数だけを出す。GitHubへは一切書き込まない
#   apply           実際に書き込む。実行前に必ずdry-runで確認すること
#
# 挙動:
# - 対象は`gh repo list`が返す非アーカイブの全リポジトリ（privateを含む。直近pushの有無では落とさない）
# - アーカイブ済みは変更せず、スキップとして一覧に出す
# - 一部のリポジトリで失敗しても残りを処理し、最後に成功・失敗・スキップの一覧を出す
#   （失敗があれば終了コード1）
# - 管理外のラベル（正本にも旧名にも無いもの）は**削除せず報告だけ**する。
#   `--delete-unmanaged`に当たる操作は無い（既存Issueからラベルが外れて戻せないため）
# - 再実行しても差分・重複ラベルは出ない（差分が無ければ「変更なし」）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/../.github/labels.json"
ORG="guchi-apps"
MODE="dry-run"
ONLY_REPOS=()

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    dry-run | apply) MODE="$1" ;;
    --org) ORG="${2:?--org には値が必要です}"; shift ;;
    --repo) ONLY_REPOS+=("${2:?--repo には値が必要です}"); shift ;;
    --manifest) MANIFEST="${2:?--manifest には値が必要です}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "エラー: 不明な引数です: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for cmd in gh jq; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "エラー: ${cmd} コマンドが見つかりません" >&2; exit 2; }
done

[ -f "$MANIFEST" ] || { echo "エラー: 正本が見つかりません: $MANIFEST" >&2; exit 2; }

# 正本の形式検査。ここで落とせば、途中まで書き込んでから壊れた定義に気づく事態を避けられる
if ! jq -e '
  (.labels | type == "array" and length > 0)
  and ([.labels[].name] | (length == (unique | length)))
  and ([.labels[].name | ascii_downcase] | (length == (unique | length)))
  and all(.labels[]; (.color | test("^[0-9a-fA-F]{6}$")) and ((.description // "") | length) <= 100)
  and all((.renames // [])[]; (.from | type == "string") and (.to | type == "string"))
' "$MANIFEST" >/dev/null 2>&1; then
  echo "エラー: 正本の形式が不正です（名前の重複・色が6桁の16進でない・説明が100文字超のいずれか）: $MANIFEST" >&2
  exit 2
fi

MANIFEST_JSON="$(cat "$MANIFEST")"

urlencode() {
  printf '%s' "$1" | jq -sRr @uri
}

# 既存ラベル一覧とマニフェストから、必要な操作を計算する（書き込みは行わない）。
# 出力: {"actions":[{op,...}], "unmanaged":[名前]}
#   op=rename  旧名が存在し、新名が無い → 改名（大文字小文字だけの違いもここ）
#   op=merge   旧名・新名の両方がある → 旧名のIssueを新名へ付け替えて旧名を削除
#   op=create  新名が無い → 作成
#   op=update  色・説明が違う → 更新
PLAN_JQ='
def lc: ascii_downcase;
def diff_update($cur; $w):
  if (($cur.color | lc) != ($w.color | lc)) or (($cur.description // "") != $w.description)
  then [{op: "update", name: $w.name, color: $w.color, description: $w.description}]
  else [] end;

. as $existing
| ($m.labels) as $want
| (reduce ($m.renames // [])[] as $r ({state: $existing, actions: []};
    (.state | map(select(.name == $r.from)) | first) as $src
    | if $src == null then .
      else
        (.state | map(select(((.name | lc) == ($r.to | lc)) and (.name != $r.from))) | first) as $dst
        | if $dst != null
          then .actions += [{op: "merge", from: $r.from, to: $dst.name}]
               | .state |= map(select(.name != $r.from))
          else .actions += [{op: "rename", from: $r.from, to: $r.to}]
               | .state |= map(if .name == $r.from then (.name = $r.to) else . end)
          end
      end)) as $renamed
| (reduce $want[] as $w ($renamed;
    (.state | map(select(.name == $w.name)) | first) as $exact
    | if $exact != null
      then .actions += diff_update($exact; $w)
      else
        (.state | map(select((.name | lc) == ($w.name | lc))) | first) as $ci
        | if $ci != null
          then .actions += [{op: "rename", from: $ci.name, to: $w.name}] + diff_update($ci; $w)
          else .actions += [{op: "create", name: $w.name, color: $w.color, description: $w.description}]
          end
      end)) as $planned
| ($want | map(.name | lc)) as $wanted
| {
    actions: $planned.actions,
    unmanaged: ($planned.state | map(.name) | map(select((. | lc) as $n | ($wanted | index($n)) == null)))
  }
'

# 失敗内容は標準エラーへ。ghはエラー時にJSONを標準出力へ出すことがあるため、終了コードで判定する
api() {
  local out
  if ! out="$(gh api "$@" 2>&1 </dev/null)"; then
    echo "      APIエラー: gh api $* → $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)" >&2
    return 1
  fi
  printf '%s' "$out"
}

fetch_labels() {
  local repo="$1" out
  if ! out="$(gh api "repos/${repo}/labels?per_page=100" --paginate 2>&1 </dev/null)"; then
    echo "  ラベル一覧を取得できません: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)" >&2
    return 1
  fi
  printf '%s' "$out" | jq -s 'add // []'
}

# 指定ラベルが付いているIssue/PRの番号（open・closedの両方）
issues_with_label() {
  local repo="$1" label="$2" out
  if ! out="$(gh api -X GET "repos/${repo}/issues" -f labels="$label" -f state=all -f per_page=100 --paginate 2>&1 </dev/null)"; then
    echo "      Issue一覧を取得できません: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)" >&2
    return 1
  fi
  printf '%s' "$out" | jq -r '.[].number'
}

OK_REPOS=()
UNCHANGED_REPOS=()
FAILED_REPOS=()
SKIPPED_LINES=()
TOTAL_RENAME=0
TOTAL_MERGE=0
TOTAL_CREATE=0
TOTAL_UPDATE=0
TOTAL_UNMANAGED=0

# 1リポジトリを処理する。失敗したら非0を返す（呼び出し側が数える）
process_repo() {
  local repo="$1" labels plan failed=0
  labels="$(fetch_labels "$repo")" || return 1
  plan="$(printf '%s' "$labels" | jq --argjson m "$MANIFEST_JSON" "$PLAN_JQ")" || {
    echo "  差分の計算に失敗しました" >&2
    return 1
  }

  local n_actions n_unmanaged
  n_actions="$(printf '%s' "$plan" | jq '.actions | length')"
  n_unmanaged="$(printf '%s' "$plan" | jq '.unmanaged | length')"
  TOTAL_UNMANAGED=$((TOTAL_UNMANAGED + n_unmanaged))

  if [ "$n_actions" -eq 0 ]; then
    echo "  変更なし"
  fi

  local action op name from to color description numbers count
  while IFS= read -r action; do
    [ -z "$action" ] && continue
    op="$(printf '%s' "$action" | jq -r .op)"
    case "$op" in
      rename)
        from="$(printf '%s' "$action" | jq -r .from)"
        to="$(printf '%s' "$action" | jq -r .to)"
        count="$(issues_with_label "$repo" "$from" | grep -c . || true)"
        echo "  改名    ${from} → ${to}（付与済み ${count} 件・付与状態は維持）"
        TOTAL_RENAME=$((TOTAL_RENAME + 1))
        if [ "$MODE" = "apply" ]; then
          api -X PATCH "repos/${repo}/labels/$(urlencode "$from")" -f new_name="$to" >/dev/null || failed=1
        fi
        ;;
      merge)
        from="$(printf '%s' "$action" | jq -r .from)"
        to="$(printf '%s' "$action" | jq -r .to)"
        numbers="$(issues_with_label "$repo" "$from")" || { failed=1; continue; }
        count="$(printf '%s\n' "$numbers" | grep -c . || true)"
        echo "  付け替え ${from} → ${to}（${count} 件のIssue/PRを移して旧ラベルを削除）"
        TOTAL_MERGE=$((TOTAL_MERGE + 1))
        if [ "$MODE" = "apply" ]; then
          local moved_all=1 number
          while IFS= read -r number; do
            [ -z "$number" ] && continue
            api -X POST "repos/${repo}/issues/${number}/labels" -f "labels[]=${to}" >/dev/null || moved_all=0
          done <<<"$numbers"
          # 1件でも付け替えに失敗したら旧ラベルを消さない（消すと付与情報が失われる）
          if [ "$moved_all" -eq 1 ]; then
            api -X DELETE "repos/${repo}/labels/$(urlencode "$from")" >/dev/null || failed=1
          else
            echo "      付け替えに失敗した件があるため、旧ラベルは削除しません" >&2
            failed=1
          fi
        fi
        ;;
      create)
        name="$(printf '%s' "$action" | jq -r .name)"
        color="$(printf '%s' "$action" | jq -r .color)"
        description="$(printf '%s' "$action" | jq -r .description)"
        echo "  作成    ${name}（#${color}）"
        TOTAL_CREATE=$((TOTAL_CREATE + 1))
        if [ "$MODE" = "apply" ]; then
          api -X POST "repos/${repo}/labels" -f name="$name" -f color="$color" -f description="$description" >/dev/null || failed=1
        fi
        ;;
      update)
        name="$(printf '%s' "$action" | jq -r .name)"
        color="$(printf '%s' "$action" | jq -r .color)"
        description="$(printf '%s' "$action" | jq -r .description)"
        echo "  更新    ${name}（色・説明を正本へ揃える）"
        TOTAL_UPDATE=$((TOTAL_UPDATE + 1))
        if [ "$MODE" = "apply" ]; then
          api -X PATCH "repos/${repo}/labels/$(urlencode "$name")" -f color="$color" -f description="$description" >/dev/null || failed=1
        fi
        ;;
    esac
  done < <(printf '%s' "$plan" | jq -c '.actions[]')

  if [ "$n_unmanaged" -gt 0 ]; then
    echo "  管理外（削除しない）: $(printf '%s' "$plan" | jq -r '.unmanaged | join("、")')"
  fi

  [ "$failed" -eq 0 ] || return 1
  if [ "$n_actions" -eq 0 ]; then
    UNCHANGED_REPOS+=("$repo")
  else
    OK_REPOS+=("$repo")
  fi
  return 0
}

echo "モード: ${MODE}（正本: ${MANIFEST}）"
if [ "$MODE" = "dry-run" ]; then
  echo "dry-runのためGitHubへは書き込みません。反映するには apply を指定してください。"
fi
echo ""

if ! REPO_LIST="$(gh repo list "$ORG" --limit 1000 --json nameWithOwner,isArchived,visibility 2>&1)"; then
  echo "エラー: リポジトリ一覧を取得できません: $(printf '%s' "$REPO_LIST" | tr '\n' ' ' | cut -c1-200)" >&2
  exit 2
fi

# 絞り込みが指定されたときは、組織に存在するものだけを対象にする（存在しない指定は失敗として数える）
if [ "${#ONLY_REPOS[@]}" -gt 0 ]; then
  WANTED_JSON="$(printf '%s\n' "${ONLY_REPOS[@]}" | jq -R 'if contains("/") then . else "'"$ORG"'/" + . end' | jq -s .)"
  for wanted in $(printf '%s' "$WANTED_JSON" | jq -r '.[]'); do
    if ! printf '%s' "$REPO_LIST" | jq -e --arg n "$wanted" 'any(.[]; .nameWithOwner == $n)' >/dev/null; then
      echo "== ${wanted}"
      echo "  組織のリポジトリ一覧に存在しません" >&2
      FAILED_REPOS+=("${wanted}（一覧に存在しない）")
    fi
  done
  REPO_LIST="$(printf '%s' "$REPO_LIST" | jq --argjson w "$WANTED_JSON" '[.[] | select(.nameWithOwner as $n | $w | index($n))]')"
fi

while IFS=$'\t' read -r repo archived visibility; do
  [ -z "$repo" ] && continue
  if [ "$archived" = "true" ]; then
    echo "== ${repo}（${visibility}）"
    echo "  アーカイブ済みのためスキップ"
    SKIPPED_LINES+=("${repo}（アーカイブ済み）")
    continue
  fi
  echo "== ${repo}（${visibility}）"
  if process_repo "$repo"; then
    :
  else
    FAILED_REPOS+=("$repo")
  fi
done < <(printf '%s' "$REPO_LIST" | jq -r 'sort_by(.nameWithOwner) | .[] | [.nameWithOwner, (.isArchived | tostring), .visibility] | @tsv')

echo ""
echo "===== 結果（${MODE}）====="
echo "対象操作: 改名 ${TOTAL_RENAME} / 付け替え ${TOTAL_MERGE} / 作成 ${TOTAL_CREATE} / 更新 ${TOTAL_UPDATE}（管理外ラベル ${TOTAL_UNMANAGED} 件は触らず報告のみ）"
echo "成功（変更あり）: ${#OK_REPOS[@]} 件"
[ "${#OK_REPOS[@]}" -gt 0 ] && printf '  - %s\n' "${OK_REPOS[@]}"
echo "成功（変更なし）: ${#UNCHANGED_REPOS[@]} 件"
[ "${#UNCHANGED_REPOS[@]}" -gt 0 ] && printf '  - %s\n' "${UNCHANGED_REPOS[@]}"
echo "スキップ: ${#SKIPPED_LINES[@]} 件"
[ "${#SKIPPED_LINES[@]}" -gt 0 ] && printf '  - %s\n' "${SKIPPED_LINES[@]}"
echo "失敗: ${#FAILED_REPOS[@]} 件"
[ "${#FAILED_REPOS[@]}" -gt 0 ] && printf '  - %s\n' "${FAILED_REPOS[@]}"

[ "${#FAILED_REPOS[@]}" -eq 0 ]
