#!/usr/bin/env bash
# サブPCで走ったPRレビューの使用量を、issue-deckへ報告する処理（#3995）。
#
# 呼ぶのは`scripts/start-codex-pr-review.sh`。このファイル自体は実行せず、source して使う。
#
# ## 流れ
#
# 1. レビューの実行後、`review_usage_record`が報告1件をJSONファイルとして**送信待ちの置き場**へ書く
# 2. `review_usage_flush`が置き場のファイルを`/api/dispatch/review-usage`へ送り、`200`を受けたものだけ消す
#
# **先に書いてから送る。** 本番が止まっている・まだ受け口が本番へ届いていない（サブPCは`develop`、
# 本番は`main`で動く）間に送れなかった報告を捨てず、次の巡回（`--sweep`の度に`review_usage_flush`）で
# 送り直す。同じファイルを何度送っても受け口は試行の識別子で上書きするので、二重には数えない。
# 置き場が`/tmp`だと再起動で消えるため、`~/.local/state`の下に置く。
#
# **計測の失敗でレビューを止めない。** どの関数も失敗を呼び出し側へ返さない（常に0で終わる）。
#
# **会話の本文は送らない。** 送るのは`codex_exec_usage_summary`が出した数値と、対象・時刻・結果のURLだけ。

REVIEW_USAGE_OUTBOX="${ISSUE_DECK_REVIEW_USAGE_OUTBOX:-${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck/review-usage-outbox}"
# 届かないまま置いておく上限。本番の不通がこれより長いときは、残しても送り先が無いとみなす。
REVIEW_USAGE_OUTBOX_MAX_DAYS="${ISSUE_DECK_REVIEW_USAGE_OUTBOX_MAX_DAYS:-30}"

_review_usage_env_value() {
  local name="$1" env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
  # 環境にあればそれを使う（pollerから起動された`--sweep`はdispatch.envを読み込み済み）。
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
    return 0
  fi
  [[ -f "$env_file" ]] || return 0
  # shellcheck disable=SC1090
  (set +eu; source "$env_file" >/dev/null 2>&1; printf '%s' "${!name:-}")
}

# Codexが実際に使うモデルを決める。`-m`で渡したならそれ、`auto`なら`~/.codex/config.toml`の
# 先頭（どのテーブルにも属さない位置）の`model`。どちらも無ければ空（＝不明。金額も出さない）。
#
#   review_usage_codex_model <指定値（autoなら設定ファイルを読む）>
review_usage_codex_model() {
  local requested="$1" config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  if [[ -n "$requested" && "$requested" != auto ]]; then
    printf '%s' "$requested"
    return 0
  fi
  [[ -f "$config" ]] || return 0
  awk '
    /^[[:space:]]*\[/ { exit }
    /^[[:space:]]*model[[:space:]]*=/ {
      line = $0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      if (match(line, /^"[^"]*"/)) { printf "%s", substr(line, 2, RLENGTH - 2); exit }
    }
  ' "$config" 2>/dev/null || true
}

# 報告1件を送信待ちの置き場へ書く。
#
#   review_usage_record <agent> <process> <owner/repo> <PR番号> <head SHA> <Issue番号|空>
#                       <status> <開始(ISO8601)> <終了(ISO8601)> <モデル|空> <結果URL|空> <集計JSON>
#
# 集計JSONは`codex_exec_usage_summary`の出力（`{"threadId":...,"usage":...}`）。
# **threadIdもusageも無い試行は記録しない。** スレッドを作る前に落ちた（設定の読み込み失敗等）
# 実行はモデルを呼んでおらず消費が無いので、「使用量の記録なし」に数えると欠損を過大に見せる。
# usageだけがあってthreadIdが無いときは、開始時刻とPIDから試行の識別子を作る。
review_usage_record() {
  local agent="$1" process="$2" repository="$3" pr_number="$4" head_sha="$5" issue_number="$6"
  local status="$7" started_at="$8" ended_at="$9" model="${10}" result_url="${11}" summary="${12}"
  mkdir -p "$REVIEW_USAGE_OUTBOX" 2>/dev/null || return 0
  REVIEW_USAGE_AGENT="$agent" REVIEW_USAGE_PROCESS="$process" REVIEW_USAGE_REPOSITORY="$repository" \
    REVIEW_USAGE_PR="$pr_number" REVIEW_USAGE_HEAD="$head_sha" REVIEW_USAGE_ISSUE="$issue_number" \
    REVIEW_USAGE_STATUS="$status" REVIEW_USAGE_STARTED="$started_at" REVIEW_USAGE_ENDED="$ended_at" \
    REVIEW_USAGE_MODEL="$model" REVIEW_USAGE_URL="$result_url" REVIEW_USAGE_SUMMARY="$summary" \
    REVIEW_USAGE_FALLBACK_ID="$(date +%s)-$$" REVIEW_USAGE_OUTBOX="$REVIEW_USAGE_OUTBOX" \
    python3 - <<'PY' 2>/dev/null || true
import json, os, re

env = os.environ
try:
    summary = json.loads(env.get("REVIEW_USAGE_SUMMARY") or "{}")
except ValueError:
    summary = {}
if not isinstance(summary, dict):
    summary = {}
attempt = summary.get("threadId") if isinstance(summary.get("threadId"), str) else ""
attempt = re.sub(r"[^A-Za-z0-9._-]", "", attempt)[:64]
if not attempt and not isinstance(summary.get("usage"), dict):
    raise SystemExit(0)
attempt = attempt or env["REVIEW_USAGE_FALLBACK_ID"]
issue = env.get("REVIEW_USAGE_ISSUE") or ""
report = {
    "agent": env["REVIEW_USAGE_AGENT"],
    "process": env["REVIEW_USAGE_PROCESS"],
    "attemptId": attempt,
    "repository": env["REVIEW_USAGE_REPOSITORY"],
    "prNumber": int(env["REVIEW_USAGE_PR"]),
    "issueNumber": int(issue) if issue.isdigit() and int(issue) > 0 else None,
    "headSha": env["REVIEW_USAGE_HEAD"],
    "status": env["REVIEW_USAGE_STATUS"],
    "usage": summary.get("usage") if isinstance(summary.get("usage"), dict) else None,
    "models": [env["REVIEW_USAGE_MODEL"]] if env.get("REVIEW_USAGE_MODEL") else [],
    "resultUrl": env.get("REVIEW_USAGE_URL") or None,
    "startedAt": env["REVIEW_USAGE_STARTED"],
    "endedAt": env["REVIEW_USAGE_ENDED"],
}
name = re.sub(r"[^A-Za-z0-9._-]", "-", f"{report['process']}-{report['repository']}-{report['prNumber']}-{attempt}")
path = os.path.join(env["REVIEW_USAGE_OUTBOX"], name + ".json")
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(report, handle, separators=(",", ":"))
os.replace(tmp, path)
PY
  return 0
}

# 送信待ちの報告を全部送る。`200`を受けたものだけ消し、それ以外（未デプロイの`404`・不通）は残す。
review_usage_flush() {
  local app_base_url dispatch_secret host_name file body status
  [[ -d "$REVIEW_USAGE_OUTBOX" ]] || return 0
  # 古すぎるものは送り先が無いとみなして捨てる（置き場が際限なく育たないように）。
  find "$REVIEW_USAGE_OUTBOX" -maxdepth 1 -name '*.json' -mtime "+$REVIEW_USAGE_OUTBOX_MAX_DAYS" -delete 2>/dev/null || true
  app_base_url="$(_review_usage_env_value APP_BASE_URL)"
  dispatch_secret="$(_review_usage_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 0
  host_name="$(_review_usage_env_value DISPATCH_HOST_NAME)"
  [[ -n "$host_name" ]] || host_name="$(hostname -s 2>/dev/null || printf 'unknown')"
  command -v jq >/dev/null 2>&1 || return 0

  for file in "$REVIEW_USAGE_OUTBOX"/*.json; do
    [[ -f "$file" ]] || continue
    body="$(jq -c --arg host "$host_name" '{host: $host, reports: [.]}' "$file" 2>/dev/null)" || {
      rm -f "$file"
      continue
    }
    # シークレットはコマンドライン引数に置かない（`ps`で見えるため）。
    status="$(printf 'Authorization: Bearer %s\n' "$dispatch_secret" |
      curl --silent --max-time 15 --request POST --header @- \
        --header 'Content-Type: application/json' --data-binary "$body" \
        --output /dev/null --write-out '%{http_code}' "${app_base_url%/}/api/dispatch/review-usage" 2>/dev/null ||
      true)"
    case "$status" in
      200) rm -f "$file" ;;
      # 受け口が読めない形は何度送っても通らない。残すと置き場に溜まり続けるので捨てる。
      400) echo "警告: 使用量の報告が受け付けられませんでした（$(basename "$file")）。" >&2; rm -f "$file" ;;
      *) ;;
    esac
  done
  return 0
}

# 使用量の報告を入れる前（#3995より前）のCodex PRレビューを、実行の記録として補完する。
#
#   review_usage_backfill_logs <作業場> <owner> <repo>
#
# 旧形式の実行ログ（`<repo>-<PR>-<SHA12>.log`。`codex exec`の表示用出力）には、見出しの
# `model:`・`session id:`と末尾の`tokens used`（合計だけ）が残っている。**入力・キャッシュ・出力の
# 内訳が無いため金額は出せず、合計を入力へ寄せるような推測もしない。** 実行があった事実だけを
# 「使用量の記録なし」（`usage: null`）の試行として送る。開始・終了はプロンプト（`.md`）とログの
# 更新時刻、結果は`.out`の判定から取る。
#
# 新形式（`--json`）のログは標準エラーだけで見出しを持たないので、`session id:`の有無で見分けて
# 二重に送らない。補完済みのログには`.usage-backfilled`の印を置き、次の巡回で読み直さない。
review_usage_backfill_logs() {
  local work_root="$1" owner="$2" repo="$3" log name rest pr_number sha12 model session_id
  local out_file md_file status started_at ended_at head_ref issue_number summary
  [[ -d "$work_root" ]] || return 0
  for log in "$work_root/$repo"-*.log; do
    [[ -f "$log" && ! -e "$log.usage-backfilled" ]] || continue
    name="$(basename "$log" .log)"
    rest="${name#"$repo"-}"
    [[ "$rest" =~ ^([1-9][0-9]*)-([0-9a-f]{12})$ ]] || continue
    pr_number="${BASH_REMATCH[1]}"
    sha12="${BASH_REMATCH[2]}"
    session_id="$(sed -n 's/^session id: *\([A-Za-z0-9._-]*\).*$/\1/p' "$log" | head -n 1)"
    if [[ -z "$session_id" ]]; then
      : >"$log.usage-backfilled"
      continue
    fi
    model="$(sed -n 's/^model: *\([A-Za-z0-9._-]*\).*$/\1/p' "$log" | head -n 1)"
    out_file="$work_root/$name.out"
    md_file="$work_root/$name.md"
    if grep -qE 'issue-deck-codex-review-verdict:(lgtm|needs-check|changes-requested) ' "$out_file" 2>/dev/null; then
      status=completed
    else
      status=failed
    fi
    ended_at="$(date -u -r "$log" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || continue
    started_at="$(date -u -r "$md_file" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s' "$ended_at")"
    head_ref="$(gh api "repos/${owner}/${repo}/pulls/${pr_number}" --jq '.head.ref' 2>/dev/null || true)"
    issue_number=""
    [[ "$head_ref" =~ ^issue-([1-9][0-9]*)$ ]] && issue_number="${BASH_REMATCH[1]}"
    summary="$(printf '{"threadId":"%s","usage":null}' "$session_id")"
    review_usage_record codex codex-pr-review "$owner/$repo" "$pr_number" "$sha12" "$issue_number" \
      "$status" "$started_at" "$ended_at" "$model" "" "$summary"
    : >"$log.usage-backfilled"
  done
  return 0
}
