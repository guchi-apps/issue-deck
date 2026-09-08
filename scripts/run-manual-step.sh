#!/usr/bin/env bash
# 手作業アシスタントから承認された手順を、このホストで実行して結果をissue-deckへ返す（#1828）。
#
#   issue-deckの画面（手作業アシスタント）で「承認して実行」
#     → ジョブ（kind=MANUAL_STEP）がキューに積まれる
#          ↑ ポーリング
#     scripts/subpc-dispatch-poller.sh が本文と照合してから
#     → このスクリプト（**pollerとは別のプロセス・別のcgroupで走る**）
#     → コマンドを実行し、終了コードと出力を POST /api/dispatch/report で返す
#
# **pollerの子プロセスとして走らせない。** サブPCの手作業でいちばん多いのは
# 「`git pull` して poller を再起動する」で、pollerのcgroupの中で
# `systemctl --user restart issue-deck-dispatch-poller.service` を実行すると、
# 自分自身が巻き添えで殺されて結果を返せない（ジョブはタイムアウトになる）。
# 呼び出し側は `systemd-run --user --collect --unit=...` で別のcgroupへ逃がす。
#
# 使い方（pollerが呼ぶ。人が直接叩くことは想定していない）:
#   scripts/run-manual-step.sh <ペイロードのファイル>
#
# ペイロードは `{"jobId": "...", "command": "...", "runTarget": "subpc|vps"}` のJSON。
# **argvにコマンドを載せない**（`ps`で他のユーザーからも見えるため）。読み終えたら消す。
#
# `runTarget`が`vps`なら、コマンドはこのホストではなく**VPSへSSHして**実行する（#2901）。
# 接続先は`dispatch.env`の`MANUAL_STEP_VPS_SSH_TARGET`（例: `github-user@<tailnetのホスト名>`）。
# **issue-deckは接続先を知らない**——ジョブに載るのは`subpc`／`vps`の2語だけ。
#
# 実行するコマンドの正当性（手作業Issueの本文に書かれたものか）は**呼び出し側で確かめてある**。
# ここは受け取ったものを実行して結果を返すことに徹する。

set -uo pipefail

CONFIG_FILE="${DISPATCH_CONFIG_FILE:-$HOME/.config/issue-deck/dispatch.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
fi

APP_BASE_URL="${APP_BASE_URL:-}"
DISPATCH_SECRET="${DISPATCH_SECRET:-}"
HOST_NAME="${DISPATCH_HOST_NAME:-$(hostname -s)}"

# コマンドを打ち切るまでの秒数。**issue-deck側の`MANUAL_STEP_TIMEOUT_SECONDS`と揃える**
# （画面に「5分で打ち切ります」と出しているのはこの値）。ジョブのheartbeatタイムアウト（10分）より
# 短くしてあるので、打ち切った結果を必ず報告できる。
MANUAL_STEP_TIMEOUT_SECONDS="${MANUAL_STEP_TIMEOUT_SECONDS:-300}"
# 画面へ返す出力の上限（文字数）。**末尾を残して切る**（エラーは最後に出るため）。
# issue-deck側の受け口（`MANUAL_STEP_OUTPUT_MAX_LENGTH`）でも同じ長さで切る。
MANUAL_STEP_OUTPUT_MAX_CHARS="${MANUAL_STEP_OUTPUT_MAX_CHARS:-8000}"

# VPSの手順（#2901）をどこへ繋いで実行するか（`github-user@<tailnetのホスト名>`）。
# **リポジトリには置かない**（issue-deckはPUBLICで、接続先は単体では資格情報でなくとも
# 接続先の構成情報にあたる）。未設定ならVPSの手順は実行しない——pollerも同じ値を見て
# `manualStepVpsCapable`を申告するので、通常はここへ届く前に配られない。
MANUAL_STEP_VPS_SSH_TARGET="${MANUAL_STEP_VPS_SSH_TARGET:-}"
# SSHの接続待ち。**打ち切り（5分）より十分に短くする**——繋がらないことが分かるまでに
# 打ち切りまで待つと、画面には「時間切れ」しか残らず理由が分からない。
MANUAL_STEP_VPS_SSH_CONNECT_TIMEOUT="${MANUAL_STEP_VPS_SSH_CONNECT_TIMEOUT:-15}"

REPORT_RETRY_ATTEMPTS=3
REPORT_RETRY_INTERVAL=5

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/run-manual-step.sh <payload-file>" >&2
  exit 1
fi

PAYLOAD_FILE="$1"
if [[ ! -f "$PAYLOAD_FILE" ]]; then
  echo "Error: ペイロードがありません: $PAYLOAD_FILE" >&2
  exit 1
fi

JOB_ID="$(jq -r '.jobId // ""' "$PAYLOAD_FILE")"
COMMAND="$(jq -r '.command // ""' "$PAYLOAD_FILE")"
# **未知の語・空はサブPC扱い**（#2901）。この経路は#1828からずっとサブPCで実行するもので、
# 実行先を読み取れなかったときに向こう側へ倒すと、意図しないホストでコマンドが走る
RUN_TARGET="$(jq -r '.runTarget // "subpc"' "$PAYLOAD_FILE")"
[[ "$RUN_TARGET" == "vps" ]] || RUN_TARGET="subpc"
rm -f "$PAYLOAD_FILE"

if [[ -z "$JOB_ID" || -z "$COMMAND" ]]; then
  echo "Error: ペイロードが不正です（jobId / command）" >&2
  exit 1
fi
if [[ -z "$APP_BASE_URL" || -z "$DISPATCH_SECRET" ]]; then
  echo "Error: APP_BASE_URL / DISPATCH_SECRET が未設定です（$CONFIG_FILE）" >&2
  exit 1
fi

# ジョブの状態を報告する。**出力はここでしか外へ出さない**（journalへは書かない。
# シークレットが混ざりうるため、行き先はログイン必須のissue-deckの画面だけにする）。
report() {
  local status="$1" message="$2" exit_code="$3" output_file="$4"
  local payload http_status attempt

  payload="$(jq -n \
    --arg jobId "$JOB_ID" \
    --arg host "$HOST_NAME" \
    --arg status "$status" \
    --arg message "$message" \
    --argjson exitCode "$exit_code" \
    --rawfile output "$output_file" \
    '{jobId: $jobId, host: $host, status: $status, message: $message, exitCode: $exitCode,
      output: $output}')"

  for (( attempt = 1; attempt <= REPORT_RETRY_ATTEMPTS; attempt++ )); do
    http_status="$(curl -sS -o /dev/null -w '%{http_code}' \
      --max-time 30 \
      -X POST "${APP_BASE_URL%/}/api/dispatch/report" \
      -H "Authorization: Bearer $DISPATCH_SECRET" \
      -H 'Content-Type: application/json' \
      --data-binary "$payload" 2>/dev/null || printf '000')"
    case "$http_status" in
      2??) return 0 ;;
      # 繋がらなかった場合と5xxだけ再送する。401（鍵の不一致）・400（受け口が古い）は
      # 何度送っても同じ結果になる
      000 | 5??) ;;
      *) break ;;
    esac
    if (( attempt < REPORT_RETRY_ATTEMPTS )); then
      sleep "$REPORT_RETRY_INTERVAL"
    fi
  done

  echo "Error: 実行結果の報告に失敗しました（ジョブ $JOB_ID・HTTP $http_status）" >&2
  return 1
}

OUTPUT_FILE="$(mktemp -t issue-deck-manual-step.XXXXXX)"
TRIMMED_FILE="$(mktemp -t issue-deck-manual-step-out.XXXXXX)"
chmod 600 "$OUTPUT_FILE" "$TRIMMED_FILE"
cleanup() { rm -f "$OUTPUT_FILE" "$TRIMMED_FILE"; }
trap cleanup EXIT

# **cwdはホームに固定する。** 手作業のコマンドはテンプレートどおり自分で`cd`する
# （`cd ~/apps/issue-deck && git pull --ff-only`）。ここで前提条件の「カレントディレクトリ」を
# 解釈して移動すると、本文の2か所（前提条件とコマンド）が食い違ったときにどちらが効くのか
# 分からなくなる。
#
# **標準入力は閉じる。** 対話を求めるコマンドがあっても、答える相手がいないまま待ち続けない。
cd "$HOME" || exit 1

if [[ "$RUN_TARGET" == "vps" ]]; then
  if [[ -z "$MANUAL_STEP_VPS_SSH_TARGET" ]]; then
    : >"$TRIMMED_FILE"
    report failed \
      "VPSへの接続先（MANUAL_STEP_VPS_SSH_TARGET）が設定されていません（$CONFIG_FILE）。" \
      1 "$TRIMMED_FILE"
    exit 0
  fi
  # **コマンドはargvに載せず標準入力で渡す**（ローカル実行と同じ理由。VPS側の`ps`にも出さない）。
  # 向こうの`bash -s`はこの標準入力をスクリプトとして読むので、**手順の側から見た標準入力は
  # 実質的に閉じている**（対話を求めるコマンドは代行の対象から外してある）。
  # cwdは接続先のホーム——ローカル実行と同じで、手順はテンプレートどおり自分で`cd`する。
  #
  # **`timeout`はVPS側にも掛ける**（#2901の計画レビューG1・指摘1）。PTYを取らないSSHでは、
  # ローカルの`ssh`をTERMで殺しても**リモートのコマンドは走り続ける**（実測で確認した）。
  # ローカルだけに掛けると、5分の打ち切りも「中断する」（`systemctl --user stop`）も
  # サブPC側の`ssh`を消すだけになり、本番サーバーでコマンドが走り続ける。
  # ローカル側は接続の分だけ長くしておき、**先に切れるのは必ずVPS側**にする。
  timeout --signal=TERM --kill-after=10s \
    $(( MANUAL_STEP_TIMEOUT_SECONDS + MANUAL_STEP_VPS_SSH_CONNECT_TIMEOUT + 15 )) \
    ssh -o BatchMode=yes \
      -o ConnectTimeout="$MANUAL_STEP_VPS_SSH_CONNECT_TIMEOUT" \
      "$MANUAL_STEP_VPS_SSH_TARGET" \
      "timeout --signal=TERM --kill-after=10s $MANUAL_STEP_TIMEOUT_SECONDS bash -s" \
    <<<"$COMMAND" >"$OUTPUT_FILE" 2>&1
  EXIT_CODE=$?
else
  timeout --signal=TERM --kill-after=10s "$MANUAL_STEP_TIMEOUT_SECONDS" \
    bash -c "$COMMAND" </dev/null >"$OUTPUT_FILE" 2>&1
  EXIT_CODE=$?
fi

# 末尾を残して切る（先頭ではなく末尾なのは、エラーが最後に出るため）。
#
# **バイトで切ったあとに壊れた文字を落とす。** `tail -c`はバイト単位なので、日本語の出力では
# 先頭が多バイト文字の途中になりうる。そのままだと`jq --rawfile`が不正なUTF-8で落ち、
# 実行できていたのに結果が返らない。issue-deck側でも文字数で切り直す（多めに送ってよい）。
tail -c $(( MANUAL_STEP_OUTPUT_MAX_CHARS * 3 )) "$OUTPUT_FILE" 2>/dev/null |
  iconv -c -f UTF-8 -t UTF-8 >"$TRIMMED_FILE" 2>/dev/null || true

# **どこで実行したのかを結果にも書く**（#2901）。画面には手順のデバイスも出ているが、
# 実行がSSH越しだったかどうかは、失敗を読むときにいちばん先に知りたい。
if [[ "$RUN_TARGET" == "vps" ]]; then
  WHERE="VPSで"
else
  WHERE=""
fi

if (( EXIT_CODE == 0 )); then
  report succeeded "${WHERE}実行しました（終了コード 0）" "$EXIT_CODE" "$TRIMMED_FILE"
elif (( EXIT_CODE == 124 || EXIT_CODE == 137 )); then
  # `timeout`が打ち切った（124はTERM、137はKILLまで至った場合）
  report failed "${MANUAL_STEP_TIMEOUT_SECONDS}秒を過ぎたため打ち切りました。" \
    "$EXIT_CODE" "$TRIMMED_FILE"
else
  report failed "${WHERE}コマンドが終了コード $EXIT_CODE で終わりました。" \
    "$EXIT_CODE" "$TRIMMED_FILE"
fi

# **実行そのものの成否はジョブの結果として返している。** このスクリプト自身は、報告できたか
# どうかだけを終了コードにする（systemd-runの transient unit のログに残る）。
exit 0
