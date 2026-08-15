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
# ジョブには種別（`kind`）があり、立ったあとのセッションを操作するものも同じキューで流れる（#1332）。
#
#   INTERRUPT   … `tmux send-keys -t <セッション名> C-c`（走っている処理を止める。セッションは残る）
#   KILL        … `tmux kill-session -t <セッション名>`（セッションごと畳む）
#   INSTRUCTION … 人が書いた1行を入力欄へ送る（#1012）。**3段階プロトコル**（下記）で送る
#
# 立てるセッションにも2種類ある（#1454）。
#
#   LAUNCH              … 実装セッション。scripts/start-local-session.sh 経由でworktreeを作る
#   CROSS_REPO_QUESTION … 複数リポジトリ横断の質問セッション。worktreeを作らず、このホストが
#                         実行できる全リポジトリを読み取り用に参照させる
#                         （scripts/start-cross-repo-question.sh）
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
#   DISPATCH_MAX_SESSIONS           生かしておく実装セッションの上限（省略時は12）
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
#
# 2: ジョブの種別（`kind`）を読み、走っているセッションの停止・終了を実行する（#1332）。
# 3: セッションの本数と上限（#1361）を申告に載せ、画面が待機の理由を出せるようにする（#1394）。
# 4: 追加指示（`INSTRUCTION`）を3段階プロトコルで送る（#1012）。
# 5: 複数リポジトリ横断の質問セッション（`CROSS_REPO_QUESTION`）を起こす（#1454）。
# 6: Claude Codeが起動確認（フォルダの信頼確認）で止まっているセッションを報告する（#1465）。
DISPATCH_POLLER_VERSION="6"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 「どのリポジトリを起動できるか」の判定は受け口（start-local-session.sh）と共有する。
# **判定を二重に持つと、申告と実際の起動可否が必ずずれる**（#1179のコメント）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# 進捗報告の設定漏れを起動時に1度だけ知らせるために読む（#1236。報告そのものはランチャーが行う）。
# shellcheck source=scripts/lib/progress-report.sh
source "$SCRIPT_DIR/lib/progress-report.sh"
# セッションを畳んだときの状態ファイルの後始末に使う（#1332。reap-sessions.shと同じ扱い）。
# shellcheck source=scripts/lib/session-state.sh
source "$SCRIPT_DIR/lib/session-state.sh"

LAUNCHER="$SCRIPT_DIR/start-local-session.sh"
# 複数リポジトリ横断の質問セッション（#1454）。**実装セッションとは別のランチャー**で、
# worktreeを作らず、このホストが実行できる全リポジトリを読み取り用に参照させる。
QUESTION_LAUNCHER="$SCRIPT_DIR/start-cross-repo-question.sh"
# 開発サーバーの回収（#1223）。**新しい常駐プロセスは増やさず、この1巡に相乗りさせる。**
REAPER="$SCRIPT_DIR/reap-dev-servers.sh"
# 作業が終わったセッションの回収（#1256・#1223の第2段階）。同じく1巡に相乗りさせる。
SESSION_REAPER="$SCRIPT_DIR/reap-sessions.sh"

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

# 進捗（Project Status）の報告はランチャー側の仕事だが、鍵が無いと**黙って報告されない**まま
# セッションだけが立つ（起動は成功しているので、画面からは`Ready`のまま動かないように見える。
# #1236）。ここで気づけるよう、起動時に1度だけ確かめて警告する。**報告できないこと自体は
# 起動を止める理由にしない**（画面やカンバンから手で進める使い方も成立する）。
if ! progress_endpoint_available "$SCRIPT_DIR/.."; then
  echo "警告: PROGRESS_REPORT_SECRET / APP_BASE_URL が見つからないため、このホストで起動した" >&2
  echo "  セッションはIssueの進捗（Project Status）を報告しません（$DISPATCH_ENV_FILE）。" >&2
  echo "  書式は issue-deck の deploy/subpc/dispatch.env.example を参照してください。" >&2
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

# 生かしておく実装セッションの上限（#1361）。
#
# `AppSetting.dispatchConcurrency` は**ジョブの払い出しにしか効かない**（tmuxが立った時点で
# ジョブは`succeeded`）ため、生きているセッションの本数には上限が無い。回収（reap-sessions.sh）は
# 「判定できなければ畳まない」設計で、IssueがOPENだったり人の入力待ちのセッションは正当に残るので、
# 入口を絞らない限り本数は単調に増える。2026-08-14には34本まで積み上がり、サブPCが
# メモリ枯渇で停止した（SSHもコンソールも応答せず、Magic SysRqでの再起動が要った）。
#
# 上限はホストの搭載メモリで決まる。サブPC（13.9GB）では実測で1セッション約390MBに加え、
# 開発サーバーが最大3本（#1177）走るため、12本で1〜2割の余裕を残す見当。
# 別のホストへ載せるときは搭載メモリに合わせて dispatch.env で変える。
MAX_SESSIONS="$(require_positive_int DISPATCH_MAX_SESSIONS "${DISPATCH_MAX_SESSIONS:-}" 12)"

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
# スクリーンショットを撮れるか（#1268）。**Playwrightのブラウザ本体があるかで見る。**
# リポジトリごとのnode_modulesではなくここを見るのは、ブラウザ本体の置き場が共通で、
# どのリポジトリが入れたかに依存しないため。
#
# `PLAYWRIGHT_BROWSERS_PATH`が設定されていればそちらを優先する（公式の環境変数）。
# **判定できない場合は「撮れない」と申告する。** 撮れると言って詰まるより、選ばせない方が軽い。
screenshot_capable() {
  local dir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  if [[ -d "$dir" ]] && compgen -G "$dir/*" >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

# 生きている実装セッションの本数（#1361）。
#
# 数えるのは `<リポジトリ名>-issue-<番号>` に一致するものだけ。この仕組みが作ったセッションの
# 名前の形で、report_sessions が送る対象と同じ。人が手で立てたセッションまで数えると、
# この仕組みと関係のない事情でジョブが取れなくなる。
count_issue_sessions() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null |
    grep -cE '^.+-issue-[1-9][0-9]*$' || true
}

# 横断質問セッション（#1454）を起こせるか。**ランチャーが手元にあるかで判定する。**
# 申告した種別のジョブは実行できなければならないため、`true`固定にはしない（pollerだけ
# 新しくしてランチャーが同期されていない、という状態がありうる）。
cross_repo_question_capable() {
  if [[ -f "$QUESTION_LAUNCHER" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

announce() {
  local repositories payload live_sessions
  repositories="$(local_repo_list_runnable | jq -R . | jq -s .)"
  # **申告するのは1巡の入口で数えた本数**（#1394）。この後の回収（reap_sessions）で減ったぶんは
  # 次の巡の申告に乗る。画面に出すのは「最後に申告した時点」の数字で、判定そのものは
  # 引き続き claim の直前で数え直す（下の run_once）。回収を待ってから申告する形にすると、
  # 回収が長引いたぶんだけ生存報告が遅れ、応答していないホストとして扱われうる。
  live_sessions="$(count_issue_sessions)"

  # `sessionControl`は「セッションの停止・終了（#1332）を実行できる」という申告。
  # **issue-deck側はこれが真のホストにしか制御ジョブを配らない。** 古いpollerは`kind`を
  # 読まないため、受け取ると起動ジョブとして解釈してセッションを立ててしまう。
  #
  # `instruction`は「追加指示（#1012）を3段階プロトコルで送れる」という申告。**`sessionControl`とは
  # 別に持つ。** あちらが送るのは固定の`C-c`だけなのに対し、こちらは内容のある文字列を送るため、
  # 実装が入っていないpollerへ配ると（未知の種別として`failed`になり）指示が必ず失われる。
  #
  # `maxSessions`・`liveSessions`は**画面へ出すためだけの申告**（#1394）。上限に達している間は
  # 起動ジョブを取りに行かない（#1361）ため、これが無いと画面は「順番待ちのまま進まない」理由を
  # 出せず、pollerが落ちている状態と区別が付かない。**issue-deck側はこの値で割り当てを判定しない**
  # （サブPCのtmuxを見られるのはこちらだけで、向こうに判定を置くと必ずずれる）。
  payload="$(jq -n \
    --arg host "$HOST_NAME" \
    --argjson repositories "$repositories" \
    --argjson contractVersion "$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION" \
    --arg agentVersion "$DISPATCH_POLLER_VERSION" \
    --argjson screenshotCapable "$(screenshot_capable)" \
    --argjson maxSessions "$MAX_SESSIONS" \
    --argjson liveSessions "$live_sessions" \
    --argjson crossRepoQuestion "$(cross_repo_question_capable)" \
    '{host: $host, repositories: $repositories, contractVersion: $contractVersion, agentVersion: $agentVersion, screenshotCapable: $screenshotCapable, sessionControl: true, instruction: true, crossRepoQuestion: $crossRepoQuestion, maxSessions: $maxSessions, liveSessions: $liveSessions}')"

  if ! api_call POST /api/dispatch/hosts "$payload"; then
    report_api_failure "ホストの申告に失敗しました"
    return 1
  fi
  echo "申告しました: $HOST_NAME（セッション $live_sessions/$MAX_SESSIONS） → $(printf '%s' "$repositories" | jq -r 'join(", ")')"
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

# --- セッションの回収（#1256）---------------------------------------------------
# 作業が終わった実装セッション（tmuxセッションと`claude`プロセス）そのものを畳む。
# 開発サーバーの回収と同じく、**判断は挟まない計器**（docs/multi-agent/gates.md）で、畳む条件は
# すべて回収スクリプト側にある。ここは「呼ぶ」だけを持つ。
#
# 猶予の分数は `SESSION_IDLE_MINUTES`（dispatch.env）で変えられる。dispatch.envは `set -a` 付きで
# 読んでいるため、そのまま環境変数として回収スクリプトへ届く。
reap_sessions() {
  if [[ ! -f "$SESSION_REAPER" ]]; then
    return 0
  fi
  # **回収の失敗でポーリングを止めない**（開発サーバーの回収・申告・報告と同じ扱い）。
  bash "$SESSION_REAPER" || echo "Error: セッションの回収に失敗しました。" >&2
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

  if api_call POST /api/dispatch/report "$payload"; then
    return 0
  fi

  # 受け口が`skipped`（#1229）を知らない版数だと400で弾かれる。**pollerとissue-deckは
  # 別々に更新される**（pollerは本体の作業ツリー＝developを追い、issue-deckの画面はmainから
  # 動く）ため、こちらが先に新しくなる期間が必ずある。そのまま諦めると、起動を見送ったジョブが
  # `RUNNING`のまま残り、10分後にタイムアウトで「応答なし」になる。
  # **見送りは失敗より軽い事実なので、失敗としてなら報告できる間はそちらで報告する。**
  if [[ "$status" == "skipped" && "$API_RESPONSE_STATUS" == "400" ]]; then
    echo "  受け口が skipped を受け付けないため failed で報告します（issue-deckの版数が古い）" >&2
    report_job "$job_id" failed "$message" "$session"
    return 0
  fi

  # **報告の失敗で処理を止めない。** issue-deckが単一障害点にならないようにする取り決め
  # （/api/progress と同じ）。報告が届かないジョブはissue-deck側のタイムアウトが拾う。
  report_api_failure "ジョブ状態の報告に失敗しました（$job_id → $status）"
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

# Claude Codeが起動確認で止まっているとみなすまでの猶予（秒。#1465）。
#
# 起動には数秒かかり、初回はプラグインの同期や自動更新でもう少し延びる。**短くすると
# 正常な起動を「止まっている」と報告する**（Issueコメント＋`00.check-user`が付く）ため、
# 起動にかかる時間より十分長く取る。逆に長くしても、気づくのが遅れるだけで害は無い。
CLAUDE_START_GRACE_SECONDS="${ISSUE_DECK_CLAUDE_START_GRACE_SECONDS:-180}"

# そのセッションが「Claude Codeをまだ開始していない」状態か（#1465）。
#
# 判定材料はランチャーが置く印（`lib/session-state.sh`の`.starting`）だけで、**画面
# （`capture-pane`）は読まない**（docs/multi-agent/gates.md「計器」。画面の文字列からの推定は
# 実地で誤判定した実績がある）。印を消すのは`SessionStart`フックなので、残っている＝
# Claude Codeがまだ開始していない、と確実に言える。
#
# 印が無ければ`false`（正常に開始した、または印を置かない古いランチャーで起きたセッション）。
claude_start_pending() {
  local session="$1" since now
  since="$(session_state_starting_since "$session" 2>/dev/null || true)"
  [[ "$since" =~ ^[0-9]+$ ]] || { printf 'false'; return 0; }
  now="$(date +%s)"
  if ((now - since >= CLAUDE_START_GRACE_SECONDS)); then
    printf 'true'
  else
    printf 'false'
  fi
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
  #
  # **区切りのタブはANSI-Cクォート（`$'...'`）で実タブとして渡す。** tmuxはフォーマット
  # 文字列の`\t`を展開せず、リテラルの`\`と`t`をそのまま出す（3.0a・3.4で確認）。通常の
  # シングルクォートで書くと1行が丸ごと`session_name`へ入り、次の正規表現に一致せず
  # **全ペインが捨てられて常に0件**になる（#1241。0件でも空配列を送る設計のためエラーにも
  # ならず、静かに送り続ける）。
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
      --argjson claudeStarting "$(claude_start_pending "$session_name")" \
      '{tmuxSessionName: $tmuxSessionName, repositoryFullName: $repositoryFullName,
        issueNumber: $issueNumber, paneDead: $paneDead, paneDeadStatus: $paneDeadStatus,
        claudeStarting: $claudeStarting}')")
  done < <(tmux list-panes -a -F $'#{session_name}\t#{pane_dead}\t#{pane_dead_status}' 2>/dev/null || true)

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

# セッション名を組み立てる（#1224の重複起動ガードと#1332の制御ジョブで共有）。
# 規約は`<リポジトリ名>-issue-<番号>`（docs/multi-agent/local-quick-start.md「セッション名」）。
expected_session_name() {
  local repo="$1" issue_number="$2"
  printf '%s' "${repo//[^A-Za-z0-9_-]/-}-issue-$issue_number"
}

# --- 追加指示の送出（#1012・3段階プロトコル）------------------------------------
# `docs/multi-agent/gates.md`は`send-keys`での文字列・確定キーの送出を禁じている。事故は
# 「選択フォームの表示中に本文＋Enterを送り、1問目が既定の選択肢で勝手に回答済みになった」。
# ここではその禁止を、**同じgates.mdが定めた3段階プロトコルの形でだけ**開ける。
#
#   1. 状態確認   … 状態ファイル・画面の両方で「いま送ってよい」ことを確かめる
#   2. 本文のみ送出 … `send-keys -l`（リテラル）。**Enterは送らない**
#   3. 反映の再確認 … 送った本文が入力欄に現れたことを確かめる
#   4. 確定キーを別送 … ここで初めて`Enter`
#
# **どの段で止まってもEnterは送らない。** 確かめられないときは必ず「送らない」側へ倒す
# （Claude Codeの画面が変わって想定の形が見つからない場合も同じ）。

# 入力欄のプロンプト記号。**これ単体を根拠にしない。** 選択フォームのカーソルも同じ記号で、
# 見分けが付かない（それがこのプロトコルの前提）。決め手は状態ファイル（段1a）と、
# 送った本文が実際に入力欄へ現れたという肯定的な確認（段3）の2つ。
INSTRUCTION_PROMPT_MARK=$'❯'
# 処理中に画面の下端へ出るヒント。**これがある間は作業中**なので送らない。
INSTRUCTION_BUSY_HINT="esc to interrupt"
# ヒントを探す範囲（画面の下端から数えた行数）。**画面全体を見ない。** 会話の本文に同じ文字列が
# 映っているだけで送れなくなる。入力欄の枠とヒントは実測でいちばん下の4行に収まる。
INSTRUCTION_STATUS_LINES=4
# 段3で突き合わせる本文の先頭文字数。**全文では突き合わせない**（入力欄は折り返すため、
# 長い本文は`❯`の行に収まらない）。狙いは「入力欄に入ったか」の確認で、全文一致は要らない。
INSTRUCTION_VERIFY_PREFIX_CHARS=16
# 反映を待つ回数と間隔（合計およそ2秒）。TUIの再描画は送出の直後には終わっていない。
INSTRUCTION_VERIFY_ATTEMPTS=10
INSTRUCTION_VERIFY_INTERVAL="0.2"

# 入力欄の行（最後の`❯`の行）を返す。無ければ空。
instruction_input_line() {
  local session="$1"
  tmux capture-pane -p -t "=$session:" 2>/dev/null |
    grep -F "$INSTRUCTION_PROMPT_MARK" | tail -1
}

# 段1: いま送ってよい状態か。送ってよければ0、そうでなければ理由を標準出力に出して1を返す。
#
# **`capture-pane`の内容を読むのはこの機能だけ。** #1217のセッション報告は「画面の内容は
# 読まない」で通しており、その線は維持する（読んだ内容で決めてよいのは「送ってよい／送らない」の
# 一方向だけで、内容から次に送るものを決めることはしない）。
instruction_ready() {
  local session="$1" event last_event pane input_line rest

  # 1a. 状態ファイル（#1219・#1357）。**最後のイベントが`Stop`のときだけ送る。**
  # `permission_prompt`は承認プロンプト・`AskUserQuestion`の表示中で、事故が起きたのはまさに
  # この状態。`working`は作業中。**記録が無いときも送らない**（判定材料が無い＝確かめられない）。
  if ! event="$(session_state_read_event "$session")" || [[ -z "$event" ]]; then
    echo "セッションの状態が記録されていないため送りませんでした（フックが動いていない可能性があります）"
    return 1
  fi
  last_event="${event##* }"
  case "$last_event" in
    Stop) ;;
    permission_prompt)
      echo "承認プロンプトまたは選択フォームの表示中のため送りませんでした（答えるのはRemote Controlから行ってください）"
      return 1
      ;;
    *)
      echo "セッションが作業中のため送りませんでした（最後のイベント: $last_event）"
      return 1
      ;;
  esac

  pane="$(tmux capture-pane -p -t "=$session:" 2>/dev/null || true)"
  if [[ -z "$pane" ]]; then
    echo "セッションの画面を読み取れなかったため送りませんでした"
    return 1
  fi

  # 1b. 処理中のヒントが出ていないこと。状態ファイルは最後のフックの時点までしか表さないため、
  # フックの間に走り出した処理はここで捕まえる。
  if printf '%s' "$pane" | tail -n "$INSTRUCTION_STATUS_LINES" | grep -qF "$INSTRUCTION_BUSY_HINT"; then
    echo "セッションが処理中のため送りませんでした"
    return 1
  fi

  # 1c. 入力欄が空であること。打ちかけの本文があると連結され、**前回の失敗で残った文字列も
  # ここで捕まる**（段3で止めたとき、こちらは追加のキーを送らずに残す）。
  input_line="$(instruction_input_line "$session")"
  if [[ -z "$input_line" ]]; then
    echo "入力欄が見つからなかったため送りませんでした（想定と違う画面が出ています）"
    return 1
  fi
  rest="${input_line#*"$INSTRUCTION_PROMPT_MARK"}"
  # **Claude Codeは空の入力欄をU+00A0（NO-BREAK SPACE）で埋める。** `[[:space:]]`はこれに
  # 当たらないため、先に落とさないと空の入力欄が「打ちかけあり」に見える（実測で確認）。
  rest="${rest//$'\u00a0'/}"
  if [[ -n "${rest//[[:space:]]/}" ]]; then
    echo "入力欄に未送信の文字が残っているため送りませんでした"
    return 1
  fi

  return 0
}

# 段3: 送った本文が入力欄に現れたか。現れれば0。
instruction_reflected() {
  local session="$1" body="$2" prefix attempt input_line
  prefix="${body:0:$INSTRUCTION_VERIFY_PREFIX_CHARS}"
  for ((attempt = 0; attempt < INSTRUCTION_VERIFY_ATTEMPTS; attempt++)); do
    input_line="$(instruction_input_line "$session")"
    if [[ -n "$input_line" && "$input_line" == *"$prefix"* ]]; then
      return 0
    fi
    sleep "$INSTRUCTION_VERIFY_INTERVAL"
  done
  return 1
}

# 追加指示を1件送る。**このプロトコルの全体がここに閉じている。**
send_session_instruction() {
  local job_id="$1" session="$2" body="$3" reason

  if [[ -z "$body" ]]; then
    report_job "$job_id" failed "追加指示の本文が空です" "$session"
    return 0
  fi
  # 受け口（`parseSessionInstruction`）と同じ検証を重ねる。**ここが最後に端末へ渡す場所**なので、
  # issue-deck側で検証済みでも改めて確かめる（多層防御。セッション名の突き合わせと同じ立場）。
  if [[ "$body" == *$'\n'* || "$body" =~ [[:cntrl:]] ]]; then
    report_job "$job_id" failed "追加指示の本文に改行または制御文字が含まれています" "$session"
    return 0
  fi
  if ((${#body} > 500)); then
    report_job "$job_id" failed "追加指示の本文が長すぎます（${#body}文字）" "$session"
    return 0
  fi

  # 段1: 状態確認
  if ! reason="$(instruction_ready "$session")"; then
    # **失敗ではなく見送り。** 安全機構が正常に働いた結果で、何も壊れていない（#1229と同じ扱い）。
    # 理由はジョブの`message`として画面に出るので、送り直すかどうかは人が判断できる。
    echo "  追加指示を見送りました: $reason"
    report_job "$job_id" skipped "$reason" "$session"
    return 0
  fi

  # 段2: 本文のみ送出（Enterは送らない）。`-l`はリテラル送出で、`--`以降を値として扱わせる
  # （`-l`が無いと`Enter`のようなキー名として解釈されうる）。
  if ! tmux send-keys -t "=$session:" -l -- "$body" 2>/dev/null; then
    report_job "$job_id" failed "追加指示の本文を送れませんでした: $session" "$session"
    return 0
  fi

  # 段3: 反映の再確認。**ここで止まったら追加のキーは一切送らない。** 本文がどこへ入ったのか
  # 分からない状態で消しにいく（`C-u`など）のは、事故の元をもう1つ増やすことになる。
  if ! instruction_reflected "$session" "$body"; then
    report_job "$job_id" failed \
      "本文が入力欄に反映されたことを確認できなかったため、Enterを送っていません。入力欄に文字が残っている可能性があります（tmux attach -t $session で確認してください）" \
      "$session"
    return 0
  fi

  # 段4: 確定キーを別送
  if ! tmux send-keys -t "=$session:" Enter 2>/dev/null; then
    report_job "$job_id" failed \
      "本文は入力欄に入りましたが、確定キーを送れませんでした（tmux attach -t $session で確認してください）" \
      "$session"
    return 0
  fi

  echo "  追加指示を送りました: $session"
  report_job "$job_id" succeeded "追加指示を送りました: $session" "$session"
  return 0
}

# --- セッションの操作（#1332・#1012）--------------------------------------------
# 画面から積まれた「停止」「閉じる」「追加指示」を実行する。
#
# **サーバーから届いたセッション名をtmuxへ渡さない。** 名前はジョブの owner/repo/Issue番号から
# こちら側で組み立て直し（起動時の重複ガードと同じ式）、届いた名前とは**照合にだけ**使う。
# ここを緩めると、共有シークレットを持つ相手が任意のtmuxターゲットを指定できる経路になる。
#
# 停止・終了で実行するのは決め打ちの2つだけで、送るキーも固定の`C-c`のみ。
# **文字列を送るのは`INSTRUCTION`だけ**で、そちらは上の3段階プロトコルを通す
# （docs/multi-agent/gates.md。選択フォームへ本文＋Enterを送って勝手に回答させた事故がある）。
run_control_job() {
  local job_id="$1" kind="$2" repo="$3" issue_number="$4" requested_session="$5"
  local instruction="${6:-}"
  local session action reason

  session="$(expected_session_name "$repo" "$issue_number")"

  # 組み立てた名前そのものも確かめる（リポジトリ名が空などで壊れた形になっていないか）。
  if [[ ! "$session" =~ ^[A-Za-z0-9_-]+-issue-[1-9][0-9]*$ ]]; then
    report_job "$job_id" failed "セッション名を組み立てられませんでした: $session"
    return 0
  fi
  # 画面が指したセッションと、こちらが導出したセッションが一致しない場合は実行しない。
  if [[ -n "$requested_session" && "$requested_session" != "$session" ]]; then
    report_job "$job_id" failed \
      "指定されたセッション名が一致しません（指定: $requested_session / 対象: $session）"
    return 0
  fi

  if ! tmux has-session -t "=$session" 2>/dev/null; then
    # **失敗ではなく見送り。** 止めたかったものが既に無いだけで、何も壊れていない（#1229と同じ扱い）
    report_job "$job_id" skipped "対象のtmuxセッションがありません: $session" "$session"
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  --dry-run のため実行しません（$kind → $session）"
    # 追加指示は「いま送ってよい状態か」の判定こそが要なので、そこだけは確認して見せる
    # （送出はしない）。手元で判定を確かめるときの唯一の手段になる。
    if [[ "$kind" == "INSTRUCTION" ]]; then
      if reason="$(instruction_ready "$session")"; then
        echo "  段1（状態確認）: 送ってよい状態です"
      else
        echo "  段1（状態確認）: $reason"
      fi
    fi
    return 0
  fi

  case "$kind" in
    INSTRUCTION)
      send_session_instruction "$job_id" "$session" "$instruction"
      return 0
      ;;
    INTERRUPT)
      action="停止（C-c）"
      # **`send-keys`の`-t`はペインを指すため、末尾の`:`が要る**（`=$session`だけだと
      # `can't find pane` で失敗する。tmux 3.4で確認）。`=`は完全一致、`:`は「そのセッションの
      # 現在のウィンドウのアクティブなペイン」で、attachして押した場合と同じ宛先になる。
      if ! tmux send-keys -t "=$session:" C-c 2>/dev/null; then
        report_job "$job_id" failed "$action を送れませんでした: $session" "$session"
        return 0
      fi
      ;;
    KILL)
      action="セッションの終了"
      if ! tmux kill-session -t "=$session" 2>/dev/null; then
        report_job "$job_id" failed "$action に失敗しました: $session" "$session"
        return 0
      fi
      # 状態ファイルを残すと、次に同じ名前で立ったセッションが前回の`Stop`を引き継いだように
      # 見える（reap-sessions.shと同じ後始末）。
      session_state_remove "$session"
      ;;
    *)
      report_job "$job_id" failed "未知のジョブ種別です: $kind"
      return 0
      ;;
  esac

  echo "  $action を実行しました: $session"
  report_job "$job_id" succeeded "$action を実行しました: $session" "$session"
  return 0
}

# ジョブを1件実行する。
#
# 起動できたかどうかは、**起動の前後でtmuxのセッション一覧を比べて増分を見る**。
# セッション名の付け方は各リポジトリの start-issue.sh 側の裁量で、こちらで先読みして
# 組み立てると規約がずれた瞬間に「起動したのに失敗と報告する」誤判定になる。
run_job() {
  local job_json="$1"
  local job_id owner repo full_name issue_number kind requested_session instruction
  job_id="$(printf '%s' "$job_json" | jq -r '.id')"
  full_name="$(printf '%s' "$job_json" | jq -r '.repositoryFullName')"
  issue_number="$(printf '%s' "$job_json" | jq -r '.issueNumber')"
  # 古いissue-deckは`kind`を返さない。**その場合は従来どおりの起動ジョブとして扱う**
  kind="$(printf '%s' "$job_json" | jq -r '.kind // "LAUNCH"')"
  requested_session="$(printf '%s' "$job_json" | jq -r '.tmuxSessionName // ""')"
  # 追加指示の本文（#1012）。`INSTRUCTION`以外では空
  instruction="$(printf '%s' "$job_json" | jq -r '.instruction // ""')"
  owner="${full_name%%/*}"
  repo="${full_name#*/}"

  echo "ジョブ $job_id: $full_name #$issue_number（$kind）"

  # 受け取った値をサブPC側でも検証する（多層防御）。issue-deck側で検証済みでも、
  # ここが最後にパス・シェル引数として使う場所なので改めて確かめる。
  if ! local_session_validate_target "$owner" "$repo" "$issue_number" 2>/dev/null; then
    report_job "$job_id" failed "受け取った owner/repo/Issue番号が不正です: $full_name #$issue_number"
    return 0
  fi

  # 横断質問セッション（#1454）。**`local_repo_check`は通さない。** 記録先リポジトリの
  # cloneは要らず（worktreeを作らず、記録先へは`gh issue comment`で書くだけ）、参照するのは
  # このホストが実行できる全リポジトリのため。1件も無い場合はランチャー側が理由を出して落ちる。
  if [[ "$kind" == "CROSS_REPO_QUESTION" ]]; then
    if [[ ! -f "$QUESTION_LAUNCHER" ]]; then
      report_job "$job_id" failed "横断質問のランチャーがありません（$QUESTION_LAUNCHER）。"
      return 0
    fi
    launch_and_report "$job_id" "$repo" "$issue_number" "横断質問セッションを起動しています" \
      bash "$QUESTION_LAUNCHER" "$owner" "$repo" "$issue_number"
    return 0
  fi

  # 起動しないジョブ（#1332）はここで終わる。**cloneの有無や版数は問わない**
  # （既に立っているセッションを操作するだけで、リポジトリには触らない）。
  if [[ "$kind" != "LAUNCH" ]]; then
    run_control_job "$job_id" "$kind" "$repo" "$issue_number" "$requested_session" "$instruction"
    return 0
  fi

  # 申告と実態がずれることはある（申告後にcloneを消した、git pullで版数が変わった等）。
  # **失敗の理由をジョブの結果として返す。** ここを省くと無人実行では何も起きないまま終わる。
  if ! local_repo_check "$full_name"; then
    report_job "$job_id" failed "$(local_repo_status_summary "$full_name")"
    return 0
  fi

  launch_and_report "$job_id" "$repo" "$issue_number" "起動しています（$LOCAL_REPO_PATH）" \
    bash "$LAUNCHER" "$owner" "$repo" "$issue_number"
}

# 重複起動を確かめてからランチャーを走らせ、tmuxセッションの増分で成否を報告する。
#
# **実装セッション（`LAUNCH`）と横断質問セッション（`CROSS_REPO_QUESTION`・#1454）で共有する。**
# 違うのは走らせるコマンドだけで、重複防止・`running`の報告・差分による成否判定・失敗時の
# 出力の返し方はまったく同じ。分けて持つと、片方だけ直したときに挙動がずれる。
#
#   $1 ジョブID / $2 リポジトリ名 / $3 Issue番号 / $4 `running`として画面へ出す文言
#   $5以降 実行するコマンド
launch_and_report() {
  local job_id="$1" repo="$2" issue_number="$3" running_message="$4"
  shift 4

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
  expected_session="$(expected_session_name "$repo" "$issue_number")"
  before="$(tmux_session_names)"
  if printf '%s\n' "$before" | grep -qxF "$expected_session"; then
    # **失敗ではなく見送り（#1229）。** ガードが正常に働いた結果で、何も壊れていない。
    # `failed`で報告すると画面が赤い「失敗」になり、ログと突き合わせるまで起動できなかったのか
    # どうか判断できない（#1224で実際に起きた）
    report_job "$job_id" skipped "同じIssueのtmuxセッションが既に動いています: $expected_session" "$expected_session"
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  --dry-run のため起動しません（$*）"
    return 0
  fi

  report_job "$job_id" running "$running_message"

  # 起動の出力は失敗時にジョブの結果として返すため取っておく。
  # stdinを閉じるのは、systemd配下には端末が無く、受け口の異常終了時の `read` 待ちへ
  # 落ちないようにするため。
  # 起動が固まってもポーリングごと止まらないよう上限を掛ける。冷えた状態からの依存インストールを
  # 含めても数分で終わる（#1177の実測）ため、既定の15分は十分な余裕がある。
  #
  # `ISSUE_DECK_SESSION_REAPABLE=1` は「このセッションはジョブとして起動した」という印で、
  # 自動回収（#1256）の対象になるのはこれが付いたセッションだけ。**この経路でしか渡さない。**
  # 手元のターミナルから直接`start-issue.sh`を叩いたセッションはissue-deck側にジョブとして
  # 残らないため、勝手に畳むと「なぜ消えたのか」を画面から辿れない。
  local output_file launch_status
  output_file="$(mktemp)"
  set +e
  ISSUE_DECK_SESSION_REAPABLE=1 \
    timeout "$LAUNCH_TIMEOUT" "$@" \
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
  # **claimより先に行う。** サブPCは並行3本が上限（#1177）で、掴んだままの開発サーバーがあると
  # 新しいジョブを取っても起こせない。取りに行く前に空けておく。
  reap_dev_servers

  # 作業が終わったセッションそのものを畳む（#1256）。**開発サーバーの回収の後に行う。**
  # 畳めば`run-issue-session.sh`のtrapが開発サーバーも止めるが、trapを通れなかったぶんは
  # 次の巡で孤児として回収される。
  reap_sessions

  # 起動済みセッションの状態を報告する（#1217）。**claimより先に行う**。
  # ここで失敗しても続けるが、先に出しておくと「取りに行く前の状態」が残り、
  # 起動が失敗したときの前後関係が読める。
  report_sessions

  if [[ "$ANNOUNCE_ONLY" -eq 1 ]]; then
    return 0
  fi

  # セッションが上限に達している間は起動ジョブを取りに行かない（#1361）。
  # **回収より前ではなく、回収の後に見る。** 直前の reap_sessions で空いたぶんを反映させたい。
  #
  # 取りに行かなくても起動ジョブは消えない。`expireStaleDispatchJobs()` が掃くのは CLAIMED と
  # RUNNING、それに古びた制御ジョブ（#1332）だけで、QUEUEDの起動ジョブは対象外のため、
  # 空きができた次の巡でそのまま取りに行ける。
  #
  # **上限に達していても取りに行くのをやめない**（#1332）。`maxJobs: 0`で「起動ジョブは要らない」
  # と伝え、停止・終了の制御ジョブだけを受け取る。上限に達しているのは**セッションを畳みたい
  # ときそのもの**で、ここで何も取りに行かないと、画面から押した停止が届かないまま5分で失効する。
  local live_sessions claim_max_jobs
  live_sessions="$(count_issue_sessions)"
  claim_max_jobs="$MAX_JOBS"
  if [[ "$live_sessions" -ge "$MAX_SESSIONS" ]]; then
    echo "セッションが上限に達しているため、起動ジョブは取りに行きません（$live_sessions/$MAX_SESSIONS 本）。"
    claim_max_jobs=0
  fi

  local claim_payload jobs_json job_count job
  claim_payload="$(jq -n --arg host "$HOST_NAME" --argjson maxJobs "$claim_max_jobs" \
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
