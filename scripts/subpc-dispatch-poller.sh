#!/usr/bin/env bash
# サブPC側のディスパッチpoller（#1179 / #1176 Phase 2）。
#
# issue-deckの画面から積まれたジョブを取りに行き、ローカルのClaude Codeセッションを起動する。
#
#   issue-deckの画面「サブPCで開始」
#     → ジョブをキューに積む
#          ↑ ポーリング（共有シークレット認証）
#     このスクリプト
#     → scripts/start-local-session.sh → 対象リポジトリの scripts/start-issue.sh
#     → tmuxセッションが立つ（以降の進捗は start-issue.sh が POST /api/progress へ報告する）
#
# **pull型なのは、VPSがtailnetに参加しておらず、Tailscale SSHにforced commandが無いため**
# （#1176）。issue-deck側からSSHでキックする経路は採れない。
#
# 使い方:
#   scripts/subpc-dispatch-poller.sh            常駐して一定間隔でポーリングする（systemdの出口）
#   scripts/subpc-dispatch-poller.sh --once     1巡だけ実行して終了する
#   scripts/subpc-dispatch-poller.sh --announce-only  申告だけ行い、ジョブは取らない（1巡）
#   scripts/subpc-dispatch-poller.sh --dry-run  claimまで行い、起動はせずに内容を表示する（1巡）
#
# **ポーリング間隔は設定値（`DISPATCH_POLL_INTERVAL_SECONDS`）で、コードにもunitにも
# 埋め込まない**（#1179のコメント）。「画面のボタンを押してから起動まで何も起きない」時間が
# 実運用で許容できるかは動かしてみないと分からず、当たりを付ける実験ができる形にしておく必要がある。
# そのため常駐ループ側に間隔を持たせている（systemd timerに持たせると、間隔の変更に
# unitの編集と`daemon-reload`が要り、pollerの他の設定と置き場所も分かれる）。
#
# 落ちたときの復帰はsystemdの`Restart=always`に任せる。1巡が長引いてポーリングごと止まらない
# よう、起動処理には`timeout`を掛ける。
#
# 設定は `~/.config/issue-deck/dispatch.env`（chmod 600）から読む。書式は
# deploy/subpc/dispatch.env.example を参照。**変更後はサービスの再起動が要る**
# （常駐プロセスが起動時に読むため）。
#
#   APP_BASE_URL                    issue-deckのURL（本番を指す。ジョブがあるのは本番のDBだけ）
#   DISPATCH_SECRET                 共有シークレット（issue-deck側の同名の環境変数と同じ値）
#   DISPATCH_HOST_NAME              このホストの名前（省略時は `hostname -s`）
#   DISPATCH_MAX_JOBS               1巡で取りに行く最大本数（省略時は1）
#   DISPATCH_POLL_INTERVAL_SECONDS  ポーリング間隔の秒数（省略時は60）
#   DISPATCH_LAUNCH_TIMEOUT_SECONDS 1件の起動に掛ける上限秒数（省略時は900）
#   DEV_SERVER_IDLE_MINUTES         開発サーバーをアイドルとみなすまでの分数（省略時は60・0で無効）
#
# 実行ログはjournaldに残る。`journalctl --user -u issue-deck-dispatch-poller -n 50` で読む。
# 起動したセッションの中身は `tmux attach -t <セッション名>`（セッション名はジョブの結果として
# issue-deckの画面にも出る）。

set -euo pipefail

# このpollerのバージョン。issue-deckへ申告し、受け口が古いまま動いていないかの手掛かりにする。
# **約束を変えたら上げる**（issue-deck側は表示するだけで、値による分岐は持たない）。
DISPATCH_POLLER_VERSION="1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 「どのリポジトリを起動できるか」の判定は受け口（start-local-session.sh）と共有する。
# **判定を二重に持つと、申告と実際の起動可否が必ずずれる**（#1179のコメント）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"

LAUNCHER="$SCRIPT_DIR/start-local-session.sh"
# 開発サーバーの回収（#1223）。**新しい常駐プロセスは増やさず、この1巡に相乗りさせる。**
REAPER="$SCRIPT_DIR/reap-dev-servers.sh"

ANNOUNCE_ONLY=0
DRY_RUN=0
ONCE=0
for arg in "$@"; do
  case "$arg" in
    --announce-only) ANNOUNCE_ONLY=1; ONCE=1 ;;
    --dry-run) DRY_RUN=1; ONCE=1 ;;
    --once) ONCE=1 ;;
    *)
      echo "Usage: scripts/subpc-dispatch-poller.sh [--once] [--announce-only] [--dry-run]" >&2
      exit 1
      ;;
  esac
done

DISPATCH_ENV_FILE="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
if [[ -f "$DISPATCH_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DISPATCH_ENV_FILE"
  set +a
fi

for required_command in curl jq tmux; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done

if [[ -z "${APP_BASE_URL:-}" || -z "${DISPATCH_SECRET:-}" ]]; then
  echo "Error: APP_BASE_URL と DISPATCH_SECRET を設定してください（$DISPATCH_ENV_FILE）。" >&2
  echo "  書式は issue-deck の deploy/subpc/dispatch.env.example を参照してください。" >&2
  exit 1
fi

HOST_NAME="${DISPATCH_HOST_NAME:-$(hostname -s)}"
MAX_JOBS="${DISPATCH_MAX_JOBS:-1}"
BASE_URL="${APP_BASE_URL%/}"

# 設定値は外部（chmod 600のファイル）から来るので、数値であることを確かめてから使う。
# 不正な値で無限に近い間隔になったり、`sleep`が毎回失敗して実質ビジーループになるのを防ぐ。
require_positive_int() {
  local name="$1" value="$2" fallback="$3"
  if [[ -z "$value" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: $name は正の整数で指定してください: $value（$DISPATCH_ENV_FILE）" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

POLL_INTERVAL="$(require_positive_int DISPATCH_POLL_INTERVAL_SECONDS "${DISPATCH_POLL_INTERVAL_SECONDS:-}" 60)"
LAUNCH_TIMEOUT="$(require_positive_int DISPATCH_LAUNCH_TIMEOUT_SECONDS "${DISPATCH_LAUNCH_TIMEOUT_SECONDS:-}" 900)"

# APIを叩く。本文を標準出力へ、HTTPステータスを最終行へ出す形は扱いにくいため、
# 一時ファイルへ本文を落としてステータスだけを返り値で見る。
# **シークレットはコマンドライン引数に置かない**（`ps` で他プロセスから見えるため）。
# `--header @-` で標準入力から渡す。
API_RESPONSE_BODY=""
API_RESPONSE_STATUS="000"
API_RESPONSE_URL=""

api_call() {
  local method="$1" path="$2" body="${3:-}"
  local response_file status
  response_file="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$response_file'" RETURN

  local curl_args=(
    --silent --show-error
    --max-time 30
    --request "$method"
    --header "Content-Type: application/json"
    --output "$response_file"
    --write-out '%{http_code}'
  )
  if [[ -n "$body" ]]; then
    curl_args+=(--data "$body")
  fi

  status="$(printf 'Authorization: Bearer %s\n' "$DISPATCH_SECRET" |
    curl "${curl_args[@]}" --header @- "$BASE_URL$path" || true)"

  API_RESPONSE_BODY="$(cat "$response_file")"
  API_RESPONSE_STATUS="${status:-000}"
  API_RESPONSE_URL="$BASE_URL$path"
  [[ "$API_RESPONSE_STATUS" =~ ^2 ]]
}

# レスポンスボディをログの1行に収まる形へ整える（#1210）。
#
# **ボディをそのまま出すとログが潰れる。** 本番が404や502を返すとNext.jsのエラーページの
# HTML（約10KB・改行入り）がそのまま返り、pollerは毎分動くため
# `journalctl -u issue-deck-dispatch-poller` がHTMLで埋まって本来見たい失敗理由が読めなくなる。
#
# 改行・タブを空白へ潰して1行にしたうえで、先頭 $LOG_BODY_MAX_CHARS 文字までに切り詰める。
# JSONのエラーレスポンス（`{"error":"..."}`）はこの長さに収まるため情報は落ちず、HTMLでも
# 先頭の `<!DOCTYPE html>` が見えれば「APIではなくページが返っている＝ルートが無い」と判断できる。
LOG_BODY_MAX_CHARS=200
summarize_response_body() {
  local body="$1"
  body="$(printf '%s' "$body" | tr '\n\r\t' '   ' | tr -s ' ')"
  body="${body#"${body%%[![:space:]]*}"}"
  body="${body%"${body##*[![:space:]]}"}"
  if [[ -z "$body" ]]; then
    printf '(本文なし)'
  elif (( ${#body} > LOG_BODY_MAX_CHARS )); then
    # 切り詰めたことが分かるよう末尾に印を付ける。
    printf '%s…' "${body:0:LOG_BODY_MAX_CHARS}"
  else
    printf '%s' "$body"
  fi
}

# APIが答えられない理由を、次に何を直せばよいかが分かる形で出す。
# **切り詰めるのはボディだけで、URLとステータスコードは必ず残す**（どの経路が何で落ちたかが
# 分からなくなると、切り詰めた意味が無い）。
report_api_failure() {
  local label="$1"
  local target="${API_RESPONSE_URL:-$BASE_URL}"
  case "$API_RESPONSE_STATUS" in
    503)
      echo "Error: $label: issue-deck側で DISPATCH_SECRET が未設定です（503 $target）。" >&2
      ;;
    401)
      echo "Error: $label: DISPATCH_SECRET の値が一致しません（401 $target）。$DISPATCH_ENV_FILE を確認してください。" >&2
      ;;
    000)
      echo "Error: $label: $target へ接続できませんでした。" >&2
      ;;
    *)
      echo "Error: $label: HTTP $API_RESPONSE_STATUS $target $(summarize_response_body "$API_RESPONSE_BODY")" >&2
      ;;
  esac
}

# --- 申告 ---------------------------------------------------------------------
# 「自分が実行できるリポジトリ」を申告する。issue-deck側はこの一覧を信じて割り当てるため、
# **start-local-session.sh と同じ4つの検証を通ったものだけ**を載せる（判定は共有ライブラリ）。
# 併せて生存報告も兼ねており、途絶えたホストはissue-deck側でofflineとして扱われる。
announce() {
  local repositories payload
  repositories="$(local_repo_list_runnable | jq -R . | jq -s .)"

  payload="$(jq -n \
    --arg host "$HOST_NAME" \
    --argjson repositories "$repositories" \
    --argjson contractVersion "$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION" \
    --arg agentVersion "$DISPATCH_POLLER_VERSION" \
    '{host: $host, repositories: $repositories, contractVersion: $contractVersion, agentVersion: $agentVersion}')"

  if ! api_call POST /api/dispatch/hosts "$payload"; then
    report_api_failure "ホストの申告に失敗しました"
    return 1
  fi
  echo "申告しました: $HOST_NAME → $(printf '%s' "$repositories" | jq -r 'join(", ")')"
  return 0
}

# --- 開発サーバーの回収（#1223）-------------------------------------------------
# セッションを畳んでも残った開発サーバー（孤児）と、作業が終わってアイドルな開発サーバーを止める。
# **判断は挟まない計器**（docs/multi-agent/gates.md）で、止める条件はすべて回収スクリプト側にある。
# ここは「呼ぶ」だけを持ち、判定を2か所に分けない。
#
# アイドル判定の分数は `DEV_SERVER_IDLE_MINUTES`（dispatch.env）で変えられる。dispatch.envは
# `set -a` 付きで読んでいるため、そのまま環境変数として回収スクリプトへ届く。
reap_dev_servers() {
  if [[ ! -f "$REAPER" ]]; then
    return 0
  fi
  # **回収の失敗でポーリングを止めない。** 次の巡で拾い直せるうえ、ここで止めるとジョブの
  # 取得そのものが行われなくなる（申告・報告と同じ扱い）。
  bash "$REAPER" || echo "Error: 開発サーバーの回収に失敗しました。" >&2
  return 0
}

# --- ジョブの実行 -------------------------------------------------------------
report_job() {
  local job_id="$1" status="$2" message="${3:-}" session="${4:-}"
  local payload
  payload="$(jq -n \
    --arg jobId "$job_id" \
    --arg host "$HOST_NAME" \
    --arg status "$status" \
    --arg message "$message" \
    --arg tmuxSessionName "$session" \
    '{jobId: $jobId, host: $host, status: $status}
      + (if $message == "" then {} else {message: $message} end)
      + (if $tmuxSessionName == "" then {} else {tmuxSessionName: $tmuxSessionName} end)')"

  if ! api_call POST /api/dispatch/report "$payload"; then
    # **報告の失敗で処理を止めない。** issue-deckが単一障害点にならないようにする取り決め
    # （/api/progress と同じ）。報告が届かないジョブはissue-deck側のタイムアウトが拾う。
    report_api_failure "ジョブ状態の報告に失敗しました（$job_id → $status）"
  fi
}

tmux_session_names() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null | sort || true
}

# --- セッションの状態報告（#1217）------------------------------------------------
# `DispatchJob`の寿命は「tmuxセッションが立った」ところで終わっており、**立った後の
# セッションは誰も見ていない**。そこを埋めるための報告。
#
# **画面（capture-pane）の内容は読まない。** 実装中のコード・環境変数が映りうるうえ、画面の
# 文字列から状態を推定する方式は既に実地で誤判定している（プランモードではフッターが
# `esc to interrupt` にならず、作業中を停止と誤って通知した。#1219・#1223）。入力待ち・完了・
# 停滞はClaude Codeのフックが担当し（#1219）、こちらはフックが飛ばない「プロセスの死・消失」だけを見る。
#
# 読むのはtmuxのメタデータだけなので、pollerに新しい依存（node等）は要らない。

# セッション名（<リポジトリ名>-issue-<番号>）から owner/repo を復元する。
# **リポジトリ名にownerが含まれない**ため、local-repos.conf の一覧の basename と突き合わせる。
# **候補が2件以上あるときは何も出力しない。** 別ownerに同名のリポジトリがあると、どちらのIssueか
# 名前だけでは決められず、当てずっぽうに選ぶと**無関係なIssueへ引き上げのコメントを投稿する**。
resolve_session_repository() {
  local repo_name="$1" full_name matched="" count=0
  while IFS= read -r full_name; do
    [[ -n "$full_name" ]] || continue
    if [[ "${full_name#*/}" == "$repo_name" ]]; then
      matched="$full_name"
      count=$((count + 1))
    fi
  done < <(local_repo_list_names)
  [[ "$count" -eq 1 ]] || return 1
  printf '%s\n' "$matched"
}

# そのホストで今見えている、Issueに紐づくtmuxセッションを報告する。
#
# **0本でも空配列を送る。** issue-deck側は「報告に含まれない＝消えた」と判定するため、
# 送らないと消失を検知できない。tmuxサーバーが動いていない場合も同じ扱いにする。
report_sessions() {
  local payload sessions_json line session_name pane_dead pane_status issue_number repo_name full_name
  local entries=()

  # セッションごとにコマンドを起動せず、1回のlist-panesで全ペインを取る。
  # `pane_dead_status`は死んだペインの終了コード（tmux 3.0aのmanに記載あり）。
  while IFS=$'\t' read -r session_name pane_dead pane_status; do
    [[ -n "$session_name" ]] || continue
    [[ "$session_name" =~ ^(.+)-issue-([1-9][0-9]*)$ ]] || continue
    repo_name="${BASH_REMATCH[1]}"
    issue_number="${BASH_REMATCH[2]}"

    # 対応表から owner/repo を戻せないセッションは送らない（他リポジトリ・曖昧な同名）。
    full_name="$(resolve_session_repository "$repo_name")" || continue

    local dead_json status_json
    if [[ "$pane_dead" == "1" ]]; then dead_json=true; else dead_json=false; fi
    if [[ "$pane_status" =~ ^-?[0-9]+$ ]]; then status_json="$pane_status"; else status_json=null; fi

    entries+=("$(jq -n \
      --arg tmuxSessionName "$session_name" \
      --arg repositoryFullName "$full_name" \
      --argjson issueNumber "$issue_number" \
      --argjson paneDead "$dead_json" \
      --argjson paneDeadStatus "$status_json" \
      '{tmuxSessionName: $tmuxSessionName, repositoryFullName: $repositoryFullName,
        issueNumber: $issueNumber, paneDead: $paneDead, paneDeadStatus: $paneDeadStatus}')")
  done < <(tmux list-panes -a -F '#{session_name}\t#{pane_dead}\t#{pane_dead_status}' 2>/dev/null || true)

  # 同じセッションに複数ペインがあると同名の項目が並ぶ。**死んでいる方を優先して1件に畳む**
  # （実装セッションは1ペインだが、人が分割した場合に取りこぼさないため）。
  sessions_json="$(printf '%s\n' "${entries[@]+"${entries[@]}"}" | jq -s '
    group_by(.tmuxSessionName)
    | map(sort_by(.paneDead) | last)')"

  payload="$(jq -n --arg host "$HOST_NAME" --argjson sessions "$sessions_json" \
    '{host: $host, sessions: $sessions}')"

  if ! api_call POST /api/dispatch/sessions "$payload"; then
    # **報告の失敗で処理を止めない。** 既存のジョブ状態の報告と同じ扱い。
    report_api_failure "セッション状態の報告に失敗しました"
    return 0
  fi

  echo "セッションを報告しました: $(printf '%s' "$sessions_json" | jq 'length') 件"
  return 0
}

# ジョブを1件実行する。
#
# 起動できたかどうかは、**起動の前後でtmuxのセッション一覧を比べて増分を見る**。
# セッション名の付け方は各リポジトリの start-issue.sh 側の裁量で、こちらで先読みして
# 組み立てると規約がずれた瞬間に「起動したのに失敗と報告する」誤判定になる。
run_job() {
  local job_json="$1"
  local job_id owner repo full_name issue_number
  job_id="$(printf '%s' "$job_json" | jq -r '.id')"
  full_name="$(printf '%s' "$job_json" | jq -r '.repositoryFullName')"
  issue_number="$(printf '%s' "$job_json" | jq -r '.issueNumber')"
  owner="${full_name%%/*}"
  repo="${full_name#*/}"

  echo "ジョブ $job_id: $full_name #$issue_number"

  # 受け取った値をサブPC側でも検証する（多層防御）。issue-deck側で検証済みでも、
  # ここが最後にパス・シェル引数として使う場所なので改めて確かめる。
  if ! local_session_validate_target "$owner" "$repo" "$issue_number" 2>/dev/null; then
    report_job "$job_id" failed "受け取った owner/repo/Issue番号が不正です: $full_name #$issue_number"
    return 0
  fi

  # 申告と実態がずれることはある（申告後にcloneを消した、git pullで版数が変わった等）。
  # **失敗の理由をジョブの結果として返す。** ここを省くと無人実行では何も起きないまま終わる。
  if ! local_repo_check "$full_name"; then
    report_job "$job_id" failed "$(local_repo_status_summary "$full_name")"
    return 0
  fi

  # 重複起動の防止（#1179）。同じIssueのtmuxセッションが既にあるなら起動しない。
  # issue-deck側のactiveKeyとは別の層で、**手元のターミナルから直接起動した分**まで拾える
  # （そちらはissue-deckにジョブとして残らないため、DB側の制約では防げない）。
  #
  # **リポジトリ名まで含めて突き合わせる**（#1224）。Issue番号はリポジトリごとに振られるため、
  # 番号だけ（`*-issue-<番号>`）で見ると、別リポジトリの同じ番号のセッションが動いているだけで
  # 起動を断ってしまう。起動できるリポジトリが1つだった間は表に出なかったが、増やした時点で
  # 番号の衝突はほぼ確実に起きる。セッション名の規約は`<リポジトリ名>-issue-<番号>`
  # （docs/multi-agent/local-quick-start.md「セッション名」）。
  local before after new_sessions expected_session
  expected_session="${repo//[^A-Za-z0-9_-]/-}-issue-$issue_number"
  before="$(tmux_session_names)"
  if printf '%s\n' "$before" | grep -qxF "$expected_session"; then
    report_job "$job_id" failed "同じIssueのtmuxセッションが既に動いています: $expected_session" "$expected_session"
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  --dry-run のため起動しません（$LOCAL_REPO_PATH）"
    return 0
  fi

  report_job "$job_id" running "起動しています（$LOCAL_REPO_PATH）"

  # 起動の出力は失敗時にジョブの結果として返すため取っておく。
  # stdinを閉じるのは、systemd配下には端末が無く、受け口の異常終了時の `read` 待ちへ
  # 落ちないようにするため。
  # 起動が固まってもポーリングごと止まらないよう上限を掛ける。冷えた状態からの依存インストールを
  # 含めても数分で終わる（#1177の実測）ため、既定の15分は十分な余裕がある。
  local output_file launch_status
  output_file="$(mktemp)"
  set +e
  timeout "$LAUNCH_TIMEOUT" bash "$LAUNCHER" "$owner" "$repo" "$issue_number" \
    </dev/null >"$output_file" 2>&1
  launch_status=$?
  set -e

  after="$(tmux_session_names)"
  new_sessions="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -v '^$' || true)"

  if [[ -n "$new_sessions" ]]; then
    local session
    session="$(printf '%s\n' "$new_sessions" | head -1)"
    echo "  起動しました: tmuxセッション $session"
    report_job "$job_id" succeeded "tmuxセッション $session を起動しました" "$session"
  else
    # 起動の出力をそのまま返す。受け口は「何を直せばよいか」まで書いて止まるため、
    # 画面にそのまま出せば原因が分かる。
    local message
    message="$(tail -c 1500 "$output_file")"
    echo "  起動できませんでした（終了コード $launch_status）" >&2
    printf '%s\n' "$message" >&2
    report_job "$job_id" failed "起動できませんでした（終了コード $launch_status）: $message"
  fi
  rm -f "$output_file"
}

# --- 1巡 ----------------------------------------------------------------------
# 申告 → claim → 起動。**1巡の失敗でプロセスを終わらせない**（常駐時は次の巡で復帰できる）。
run_once() {
  announce || return 1

  # 終わった実装セッションの開発サーバーを回収する（#1223）。
  # **claimより先に行う。** subpcは並行3本が上限（#1177）で、掴んだままの開発サーバーがあると
  # 新しいジョブを取っても起こせない。取りに行く前に空けておく。
  reap_dev_servers

  # 起動済みセッションの状態を報告する（#1217）。**claimより先に行う**。
  # ここで失敗しても続けるが、先に出しておくと「取りに行く前の状態」が残り、
  # 起動が失敗したときの前後関係が読める。
  report_sessions

  if [[ "$ANNOUNCE_ONLY" -eq 1 ]]; then
    return 0
  fi

  local claim_payload jobs_json job_count job
  claim_payload="$(jq -n --arg host "$HOST_NAME" --argjson maxJobs "$MAX_JOBS" \
    '{host: $host, maxJobs: $maxJobs}')"
  if ! api_call POST /api/dispatch/claim "$claim_payload"; then
    report_api_failure "ジョブの取得に失敗しました"
    return 1
  fi

  jobs_json="$API_RESPONSE_BODY"
  job_count="$(printf '%s' "$jobs_json" | jq '.jobs | length')"
  if [[ "$job_count" -eq 0 ]]; then
    echo "取得できるジョブはありません。"
    return 0
  fi

  echo "$job_count 件のジョブを取得しました。"
  while IFS= read -r job; do
    [[ -n "$job" ]] || continue
    run_job "$job"
  done < <(printf '%s' "$jobs_json" | jq -c '.jobs[]')
  return 0
}

if [[ "$ONCE" -eq 1 ]]; then
  run_once
  exit $?
fi

# --- 常駐 ----------------------------------------------------------------------
# systemdからの停止（SIGTERM）で待ち時間の途中でも素直に終わるようにする。
# `sleep`を子プロセスとして待ち、シグナルで割り込めるようにしておく。
SHUTDOWN=0
trap 'SHUTDOWN=1' TERM INT

echo "ポーリングを開始します（間隔 ${POLL_INTERVAL} 秒・ホスト $HOST_NAME・宛先 $BASE_URL）"
while [[ "$SHUTDOWN" -eq 0 ]]; do
  # 1巡が失敗しても止めない。issue-deckが再起動中・ネットワークが一時的に切れた、といった
  # 理由で落ちるたびにプロセスごと終わると、復帰までポーリングが空く
  run_once || true
  [[ "$SHUTDOWN" -eq 0 ]] || break
  sleep "$POLL_INTERVAL" &
  wait $! 2>/dev/null || true
done

echo "ポーリングを終了しました。"
