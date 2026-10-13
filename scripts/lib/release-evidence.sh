#!/usr/bin/env bash
# リリースの統合検証（`run-release-verify.sh`）が残す検証証跡と、全体レビュー（`run-release-review.sh`）への
# 受け渡し（#4616）。
#
# 全体レビューのAIは読み取り専用で、依存関係もテスト環境も持たない。テストの実行をAIへ丸投げせず、
# 検証ランナーが設定済みコマンドを実行した結果をここへ残し、レビューはそれを読むだけにする。
#
# - 証跡は対象（リポジトリ・PR・base SHA・head SHA）ごとのファイルで、**base/headが完全に一致するものだけ**
#   読む。候補が更新された・mainが進んだときは別ファイルになり、旧証跡は再利用されない。
# - 証跡は統合状態（main base + release head）のもの。**head単体の合格ではなく、代用もしない。**
# - 失敗の種別（failureKind）は観測した事実だけで決める。決められなければ test_failed にせず unknown。

# evidence_file <owner/repo> <PR番号> <base SHA> <head SHA>
evidence_file() {
  local full_name="$1" pr="$2" base="$3" head="$4"
  local root="${ISSUE_DECK_RELEASE_EVIDENCE_ROOT:-${TMPDIR:-/tmp}/issue-deck-release-evidence}"
  printf '%s/%s-%s-%s-%s.json' "$root" "${full_name//\//_}" "$pr" "${base:0:12}" "${head:0:12}"
}

# evidence_classify_step <コマンド> <終了コード>: 失敗の種別を標準出力へ
#   dependency_install_failed / setup_missing / timeout / test_failed
evidence_classify_step() {
  local command="$1" code="$2"
  case "$code" in
    124 | 137) printf 'timeout'; return ;;
    126 | 127) printf 'setup_missing'; return ;;
  esac
  if [[ "$command" =~ (^|[[:space:]\&\;])(pnpm|npm|yarn|bun)[[:space:]]+(install|ci|i)([[:space:]]|$) ||
    "$command" =~ pip[[:space:]]+install ]]; then
    printf 'dependency_install_failed'
    return
  fi
  printf 'test_failed'
}

# evidence_init <owner/repo> <PR番号> <base SHA> <head SHA>: 空の証跡を作る（前回の同名ファイルは捨てる）
evidence_init() {
  local file
  file="$(evidence_file "$@")"
  mkdir -p "$(dirname "$file")"
  jq -nc --arg repo "$1" --argjson pr "$2" --arg base "$3" --arg head "$4" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{repository: $repo, prNumber: $pr, baseSha: $base, headSha: $head, mode: "integration",
      integrationTarget: ("main " + $base[0:7] + " + release head " + $head[0:7]),
      headOnly: "未実施（統合状態の結果で代用しない）",
      startedAt: $at, steps: [], outcome: {state: "running"}}' >"$file"
}

# evidence_add_step <証跡ファイル> <コマンド> <passed|failed> <終了コード> <種別または空> <ログ末尾ファイル>
evidence_add_step() {
  local file="$1" command="$2" status="$3" code="$4" kind="$5" log_file="${6:-}" tail_text="" tmp
  [[ -f "$file" ]] || return 0
  [[ "$status" == "failed" && -s "$log_file" ]] && tail_text="$(tail -n 20 "$log_file" | tr -d '\000' | tail -c 2000)"
  tmp="$(mktemp)"
  jq -c --arg command "$command" --arg status "$status" --argjson code "$code" --arg kind "$kind" \
    --arg tail "$tail_text" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.steps += [{command: $command, status: $status, exitCode: $code, finishedAt: $at}
      + (if $kind == "" then {} else {failureKind: $kind} end)
      + (if $tail == "" then {} else {logTail: $tail} end)]' "$file" >"$tmp" && mv "$tmp" "$file" || rm -f "$tmp"
}

# evidence_finish <証跡ファイル> <passed|failed|needs_check> <failureKindまたは空> <詳細>
evidence_finish() {
  local file="$1" state="$2" kind="$3" detail="${4:-}" tmp
  [[ -f "$file" ]] || return 0
  tmp="$(mktemp)"
  jq -c --arg state "$state" --arg kind "$kind" --arg detail "$detail" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.finishedAt = $at | .outcome = {state: $state}
      + (if $kind == "" then {} else {failureKind: $kind} end)
      + (if $detail == "" then {} else {detail: $detail} end)' "$file" >"$tmp" && mv "$tmp" "$file" || rm -f "$tmp"
}

# evidence_prompt_text <owner/repo> <PR番号> <base SHA> <head SHA>
# レビューのプロンプトへ入れる「検証証跡」の節を標準出力へ。対象が一致する証跡が無ければ未実施として書く
evidence_prompt_text() {
  local file
  file="$(evidence_file "$@")"
  printf '## 検証証跡（テスト・型検査・ビルド）\n\n'
  printf '**あなたはテスト・型検査・ビルドを実行しません**（依存関係とテスト環境が無い読み取り専用の環境です）。実行結果は検証ランナーが取得した次の証跡だけを根拠にしてください。\n\n'
  if [[ ! -s "$file" ]] || ! jq -e --arg base "$3" --arg head "$4" '.baseSha == $base and .headSha == $head' "$file" >/dev/null 2>&1; then
    printf '現在の対象（base %s / head %s）に一致する検証証跡は**まだありません**（統合検証が未実施・実行中・または記録に失敗）。\n\n' "${3:0:7}" "${4:0:7}"
    printf '**これは「テストに失敗した」でも「コードに不具合がある」でもありません。** テストを実行できなかったことを理由に、コードへの止める指摘を出さないでください。実行結果が必要な確認項目は`unconfirmed`にし、`unverifiedScope`に「統合検証の結果待ち」と書きます。\n'
    return 0
  fi
  jq -r '
    "- 対象: \(.repository) PR #\(.prNumber)\n- base（main）: \(.baseSha)\n- head（リリース）: \(.headSha)\n- 検証した状態: **\(.integrationTarget)**（統合状態）\n- head単体: \(.headOnly)\n- 開始: \(.startedAt)\(if .finishedAt then "・終了: \(.finishedAt)" else "" end)",
    "- 結果: **\(.outcome.state)**\(if .outcome.failureKind then "（種別: \(.outcome.failureKind)）" else "" end)\(if .outcome.detail then " — \(.outcome.detail)" else "" end)",
    "",
    "### 実行したコマンド",
    (if (.steps | length) == 0 then "（まだ実行したコマンドはありません）" else (.steps[] | "- `\(.command)` → \(.status)（終了コード \(.exitCode)・\(.finishedAt)）\(if .failureKind then "［\(.failureKind)］" else "" end)\(if .logTail then "\n```\n\(.logTail)\n```" else "" end)") end)
  ' "$file"
  printf '\n種別の意味: `merge_conflict`＝統合時の競合／`dependency_install_failed`＝依存関係の取得失敗／`setup_missing`＝コマンドや設定が無い／`timeout`＝時間切れ／`test_failed`＝テスト・型検査・ビルドの不合格。**取得失敗・設定不足・時間切れは、コードの不具合の根拠にしません。** `running`は検証がまだ終わっていないことを表し、合格とは扱いません。\n'
}
