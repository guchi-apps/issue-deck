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
# **tmuxサーバーはpollerとは別のcgroup（`issue-deck-tmux-server.scope`）で起こす**（#1935）。
# 同じcgroupに入れると、pollerの停止処理（`systemctl --user restart`・異常終了→`Restart=always`）で
# 走っている実装セッションが全部落ちる。理由と置き直せる条件は`ensure_tmux_server_scope`のコメント。
#
# ジョブには種別（`kind`）があり、立ったあとのセッションを操作するものも同じキューで流れる（#1332）。
#
#   INTERRUPT   … `tmux send-keys -t <セッション名> C-c`（走っている処理を止める。セッションは残る）
#   KILL        … `tmux kill-session -t <セッション名>`（セッションごと畳む）
#   INSTRUCTION … 人が書いた1行を入力欄へ送る（#1012）。**3段階プロトコル**（下記）で送る
#
# セッションに触らないジョブもある（#1828）。
#
#   MANUAL_STEP … 手作業アシスタントで承認された1手順ぶんのコマンドを、このホストで実行する。
#   MANUAL_STEP_ABORT … 走っている代行実行を止める（#1882）。
#     `systemctl --user stop issue-deck-manual-step-<対象ジョブID>`。ユニット名は受け取った
#     ジョブidから組み立て直す（任意のユニットを止める口にしない）。
#                 **GitHubの手作業Issueの本文と照合してから**、別プロセス
#                 （scripts/run-manual-step.sh）で実行し、終了コードと出力を画面へ返す
#
# ジョブとは別に、**画面から何も押されなくても1巡ごとに行うことがある**（#1971）。
#
#   APIエラー（529等）で中断して止まったセッションの検知と自動再開
#   （`resume_interrupted_sessions`。送るのは固定の1行だけで、経路は`INSTRUCTION`と同じ
#   3段階プロトコル。CLAUDE.mdの`send-keys`禁止に対する3つ目の例外にあたる）
#
# 立てるセッションにも2種類ある（#1454）。
#
#   LAUNCH              … 実装セッション。scripts/start-local-session.sh 経由でworktreeを作る
#   CROSS_REPO_QUESTION … 複数リポジトリ横断の質問セッション。worktreeを作らず、このホストが
#                         実行できる全リポジトリを読み取り用に参照させる
#                         （scripts/start-cross-repo-question.sh）
#   PLAN_REVIEW         … 計画の関門（G1・#1218）のセッション。計画コメントの投稿を契機に
#                         **自動で積まれる**（#1855）。対象リポジトリの origin/develop の
#                         スナップショットを読み、指摘をIssueコメントへ投稿して終わる
#                         （scripts/start-plan-review.sh）
#   CODE_REVIEW         … リポジトリ全体のコードレビューのセッション（#698）。画面から人が
#                         押したときだけ積まれる。origin/develop のスナップショットを読み、
#                         指摘をレビューIssueのコメントへ投稿して終わる
#                         （scripts/start-code-review.sh）
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
#   DISPATCH_MAX_PLAN_REVIEWS       同時に走らせる計画レビューの上限（省略時は2）
#   DISPATCH_MAX_CODE_REVIEWS       同時に走らせるコードレビューの上限（省略時は2）
#   DISPATCH_MEMORY_HOLD_PERCENT    起動を見送るメモリ使用率（省略時は85・0で無効）
#   DISPATCH_SWAP_HOLD_PERCENT      起動を見送るSWAP使用率（省略時は50・0で無効）
#   DISPATCH_POLL_INTERVAL_SECONDS  ポーリング間隔の秒数（省略時は30）
#   DISPATCH_LAUNCH_TIMEOUT_SECONDS 1件の起動に掛ける上限秒数（省略時は900）
#   DEV_SERVER_IDLE_MINUTES         開発サーバーをアイドルとみなすまでの分数（省略時は20・0で無効）
#   SESSION_RESUME_ENABLED          APIエラーで中断したセッションの自動再開（省略時は1・0で無効）
#   SESSION_RESUME_STALL_MINUTES    中断とみなすまでの停滞の分数（省略時は10）
#   SESSION_RESUME_MAX_ATTEMPTS     1セッションあたりの再開の上限回数（省略時は3）
#   SESSION_RESUME_INTERVAL_MINUTES 再開を試みる間隔の分数（省略時は5）
#   SESSION_IDLE_MINUTES            セッションを畳むまでの猶予の分数（省略時は60・0で無効）
#   SESSION_HANDOFF_IDLE_MINUTES    引き渡し済みセッション専用の猶予（省略時は30・0でその経路だけ無効）
#   DISPATCH_CHECKOUT_FETCH_INTERVAL_MINUTES
#                                   チェックアウトの遅れを数え直す間隔の分数（省略時は360・0で無効）
#   WORKTREE_CLEANUP_INTERVAL_MINUTES
#                                   worktreeを掃除する間隔の分数（省略時は60・0で無効）
#   NODE_MODULES_DEDUPE_INTERVAL_MINUTES
#                                   node_modulesの重複を回収する間隔の分数（省略時は1440・0で無効）
#
# コンフリクトしたPRの巡回検知（#2116）は毎巡issue-deckへ促すだけで、**間隔の設定はここには
# 無い**。どれくらいの間隔で見に行くか（＝GitHub APIをどれだけ使うか）はissue-deck側の
# `CONFLICT_SWEEP_INTERVAL_MINUTES`（既定5分）が決める。
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
# 7: セッションの owner/repo を状態ファイルから復元し、`local-repos.conf`に載っていない
#    リポジトリ（横断質問セッションの記録先）のセッションも報告する（#1537）。
# 8: 使用率の申告にSWAPを載せ、既定のポーリング間隔を30秒にする（#1624）。
# 9: 動かしているチェックアウトの版（コミット・ブランチ・developからの遅れ）を申告する（#1612）。
# 10: マージ済みworktreeの掃除（cleanup-worktrees.sh）を一定間隔で呼ぶ（#1716）。
# 11: 手作業の代行実行（`MANUAL_STEP`）を、GitHubの本文と照合してから実行する（#1828）。
# 12: 計画レビュー（`PLAN_REVIEW`）のセッションを起こす（#1855）。
# 13: 走っている代行実行を止める（`MANUAL_STEP_ABORT`）（#1882）。
# 14: チェックアウトの更新（`SELF_UPDATE`）を実際に実行できるようにする（#1927）。13以前は
#     `selfUpdate`を申告していても、埋め草のIssue番号`0`が検証で弾かれて全件失敗していた。
# 15: tmuxサーバーを`systemd-run --user --scope`でpollerとは別のcgroupに置き、pollerの再起動で
#     走っている実装セッションが巻き添えで落ちないようにする（#1935）。
# 16: APIエラー（529等）で中断したセッションを、1巡ごとに検知して自動再開する（#1971）。
# 17: メモリ・SWAPが逼迫している間、起動ジョブを`maxJobs=0`で見送り、その理由を申告する（#2095）。
# 18: コンフリクトしたPRの巡回検知を1巡ごとにissue-deckへ促す（#2116）。
# 19: 定期的なworktreeの掃除を`--all-repos`で全リポジトリへ広げる（#2123）。
# 20: npm・yarnのworktreeで重複した`node_modules`を1日1回ハードリンクへまとめる（#2124）。
# 21: リポジトリ全体のコードレビュー（`CODE_REVIEW`）のセッションを起こす（#698）。
DISPATCH_POLLER_VERSION="21"

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
# APIエラーで中断したセッションの検知（#1971）。**転記を読むのはこの用途だけ**で、
# 判定の中身は`lib/session-resume.sh`、転記の場所の解決は`lib/session-transcript.sh`が持つ。
# shellcheck source=scripts/lib/session-transcript.sh
source "$SCRIPT_DIR/lib/session-transcript.sh"
# shellcheck source=scripts/lib/session-resume.sh
source "$SCRIPT_DIR/lib/session-resume.sh"
# メモリ・SWAPの逼迫で起動を見送るかの判定（#2095）。**判定だけを別に持つ**のは、
# 壊れると「起動が永久に止まる」か「逼迫しても止まらない」のどちらかになる境界で、
# 実機を用意せずに確かめられるようにしておきたいため（scripts/launch-hold.test.mjs）。
# shellcheck source=scripts/lib/launch-hold.sh
source "$SCRIPT_DIR/lib/launch-hold.sh"

LAUNCHER="$SCRIPT_DIR/start-local-session.sh"
# 複数リポジトリ横断の質問セッション（#1454）。**実装セッションとは別のランチャー**で、
# worktreeを作らず、このホストが実行できる全リポジトリを読み取り用に参照させる。
QUESTION_LAUNCHER="$SCRIPT_DIR/start-cross-repo-question.sh"
# 手作業の代行実行（#1828）。**pollerとは別のcgroupで走らせる**（poller自身を再起動する手順が
# あるため。理由はスクリプト冒頭のコメントを参照）。
MANUAL_STEP_RUNNER="$SCRIPT_DIR/run-manual-step.sh"
# 計画の関門（G1・#1218）のセッション（#1855）。**実装セッションとも横断質問とも別のランチャー**で、
# worktreeを作らず、対象リポジトリの`origin/develop`のスナップショットを読んで指摘を投稿する。
PLAN_REVIEW_LAUNCHER="$SCRIPT_DIR/start-plan-review.sh"
CODE_REVIEW_LAUNCHER="$SCRIPT_DIR/start-code-review.sh"
# 開発サーバーの回収（#1223）。**新しい常駐プロセスは増やさず、この1巡に相乗りさせる。**
REAPER="$SCRIPT_DIR/reap-dev-servers.sh"
# 作業が終わったセッションの回収（#1256・#1223の第2段階）。同じく1巡に相乗りさせる。
SESSION_REAPER="$SCRIPT_DIR/reap-sessions.sh"
# worktreeの掃除（#1716）。**新しい常駐プロセスもsystemd timerも増やさず、この1巡に相乗りさせる。**
# ただし上の2つと違い毎巡は呼ばず、`WORKTREE_CLEANUP_INTERVAL_MINUTES` の間隔で呼ぶ。
WORKTREE_CLEANER="$SCRIPT_DIR/cleanup-worktrees.sh"
# node_modules の重複回収（#2124）。掃除と違い、ポーリングを止めないよう別プロセスで走らせる。
NODE_MODULES_DEDUPER="$SCRIPT_DIR/dedupe-node-modules.sh"
# セッションの通知（#1219）。**通知の文面と送り先を持つのは向こう1箇所**なので、pollerからも
# 同じスクリプトを呼ぶ（#1971。自動再開をあきらめたときだけ使う）。
NOTIFY_SCRIPT="$SCRIPT_DIR/session-notify.sh"

# 起動時の引数。**チェックアウトの更新のあと`exec`で自分を入れ替えるときに渡し直す**（#1927）。
POLLER_ARGV=("$@")

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

# 0を「無効」の意味で使える設定値のための版（#1612）。回収まわりの分数（`DEV_SERVER_IDLE_MINUTES`
# など）と同じ約束で、0は壊れた値ではなく「その機能を止める」という指定。
require_non_negative_int() {
  local name="$1" value="$2" fallback="$3"
  if [[ -z "$value" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  if [[ ! "$value" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "Error: $name は0以上の整数で指定してください: $value（$DISPATCH_ENV_FILE）" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

# 既定は30秒（#1624で60秒から短くした）。この間隔がそのまま「画面のボタンを押してから起動が
# 始まるまで」と「実行キューに出る使用率の古さ」の上限になる。1巡でissue-deckへ行くのは
# HTTP 2回・DBクエリ数件なので、倍にしても負荷は無視できる。
POLL_INTERVAL="$(require_positive_int DISPATCH_POLL_INTERVAL_SECONDS "${DISPATCH_POLL_INTERVAL_SECONDS:-}" 30)"
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

# 同時に走らせる計画レビュー（#1855）の上限。**`DISPATCH_MAX_SESSIONS`とは別に持つ。**
#
# 計画レビューのセッションは`-issue-`の規約から外してあるため上の本数に数えられず、ジョブも
# セッションが立った時点で閉じる（枠が即座に空く）。**何も見ないと同時に何本でも走る**ので、
# ここで別に止める。実装セッションより小さく取るのは、読むだけで数分で終わる代わりに、
# 走っている間はモデル呼び出しがそのぶん並ぶため（1本$0.7〜1.5）。
MAX_PLAN_REVIEWS="$(require_positive_int DISPATCH_MAX_PLAN_REVIEWS "${DISPATCH_MAX_PLAN_REVIEWS:-}" 2)"
MAX_CODE_REVIEWS="$(require_positive_int DISPATCH_MAX_CODE_REVIEWS "${DISPATCH_MAX_CODE_REVIEWS:-}" 2)"

# 0〜100の割合として受け取る設定値のための版（#2095）。**0は「無効」**（その項目では見送らない）で、
# 回収まわりの分数と同じ約束。100を超える値は、そのまま「絶対に超えない閾値」＝無効と区別が
# 付かなくなるため弾く。
require_percent() {
  local name="$1" value="$2" fallback="$3"
  if [[ -z "$value" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  if [[ ! "$value" =~ ^(0|[1-9][0-9]?|100)$ ]]; then
    echo "Error: $name は0〜100の整数で指定してください: $value（$DISPATCH_ENV_FILE）" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

# メモリ・SWAPが逼迫している間、新しいセッションの起動ジョブを取りに行かないための閾値（#2095）。
# **0で無効**（その項目では見送らない）。
#
# **`DISPATCH_MAX_SESSIONS`が見ているのは本数だけで、実際の空きメモリは見ていない。** 12本に
# 届いていなくても重い作業（テスト・ビルド）が重なっていれば、そこへさらにセッションを足して
# しまう。#2076で重いコマンドの同時本数は絞ったが、あちらは走り出した後の話で、こちらは
# 「入口で実際の余力を見る」という別の対処。片方だけでは残る。
#
# 見るのは1巡の入口で集めた`metrics`（`collect_host_metrics`）で、**画面に出ている数字と同じもの**。
# 見送っている間も制御ジョブ（停止・追加指示）は従来どおり取りに行く（`live_sessions >= MAX_SESSIONS`
# と同じ形）。**取れなかった巡は見送らない**（余力が分からないことを理由に止めると、
# `/proc`が読めないだけで起動が永久に止まる）。
#
# 既定の85%は画面の使用率が赤くなる境目（`src/lib/dispatch/host-metrics.ts`の
# `CRITICAL_PERCENT`）に合わせてある。**見た目の警告と実際の見送りを同じ線に置く**ためで、
# 別の値にすると「赤いのに起動する」「赤くないのに止まっている」が起きる。
# SWAPの50%は、平常時（実装セッション6本前後）の実測が20%程度であることから取った値。
MEMORY_HOLD_PERCENT="$(require_percent DISPATCH_MEMORY_HOLD_PERCENT "${DISPATCH_MEMORY_HOLD_PERCENT:-}" 85)"
SWAP_HOLD_PERCENT="$(require_percent DISPATCH_SWAP_HOLD_PERCENT "${DISPATCH_SWAP_HOLD_PERCENT:-}" 50)"

# チェックアウトの遅れ（#1612）を数え直す間隔（分）。**0で無効**（fetchを一切行わない）。
#
# 既定の6時間は「毎巡fetchしたくない」と「遅れに気付くのが1日遅れては意味が無い」の間を取った値。
# 遅れの数字は最後にoriginを見た時点のものなので、間隔を延ばすほど申告が古くなる（どの時点の
# 数字かは`fetchedAt`として一緒に申告し、画面が古ければ注記を出す）。
CHECKOUT_FETCH_INTERVAL_MINUTES="$(require_non_negative_int \
  DISPATCH_CHECKOUT_FETCH_INTERVAL_MINUTES "${DISPATCH_CHECKOUT_FETCH_INTERVAL_MINUTES:-}" 360)"

# worktreeを掃除する間隔（分）。**0で無効**（#1716）。
#
# 既定の60分は「消し忘れを溜めない」と「1巡を長く塞がない」の間を取った値。掃除は
# `git fetch` と `gh pr list` を1回ずつ叩き、worktreeの本数ぶんの走査を行うため、
# 毎巡（30秒ごと）呼ぶには重い。
WORKTREE_CLEANUP_INTERVAL_MINUTES="$(require_non_negative_int \
  WORKTREE_CLEANUP_INTERVAL_MINUTES "${WORKTREE_CLEANUP_INTERVAL_MINUTES:-}" 60)"
# npm・yarnのworktreeで重複した node_modules をハードリンクへまとめる間隔（#2124）。
# 掃除（60分）より桁違いに重い（全リポジトリで15分前後）ので、既定は1日1回。0で無効。
NODE_MODULES_DEDUPE_INTERVAL_MINUTES="$(require_non_negative_int \
  NODE_MODULES_DEDUPE_INTERVAL_MINUTES "${NODE_MODULES_DEDUPE_INTERVAL_MINUTES:-}" 1440)"

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

# 生きている計画レビューのセッションの本数（#1855）。
#
# **`count_issue_sessions`とは別に数える。** 計画レビューのセッション名は`-issue-`の規約から
# 外してあり（そうしないとセッション報告・停止／終了の突き合わせに混ざる）、そのぶん
# `DISPATCH_MAX_SESSIONS`の計上からも外れる。ジョブはセッションが立った時点で成功として
# 閉じるため枠も即座に空き、**このまま何も見ないと同時に何本でも走りうる**。
count_plan_review_sessions() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null |
    grep -cE '^.+-plan-review-[1-9][0-9]*$' || true
}

# 生きているコードレビューのセッションの本数（#698）。**`count_plan_review_sessions`と同じ理由で
# 別に数える**（セッション名を`-issue-`の規約から外してあるぶん、`DISPATCH_MAX_SESSIONS`の
# 計上に入らない）。リポジトリ全体を読むぶん1本が重いので、上限は計画レビューと同じ2本を既定にする。
count_code_review_sessions() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null |
    grep -cE '^.+-code-review-[1-9][0-9]*$' || true
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

# 手作業の代行実行（#1828）を実行できるか。**実行スクリプトと、実行前の照合に使う`gh`が
# 揃っているかで判定する。** どちらか欠けたまま申告すると、押した実行が必ず失敗として残る。
#
# `gh`を必須にしているのは、**実行するコマンドがGitHub上の手作業Issueの本文に書かれたものか**を
# サブPC側でも確かめるため（issue-deck側の照合だけに頼らない多層防御）。
manual_step_capable() {
  if [[ -f "$MANUAL_STEP_RUNNER" ]] && command -v gh >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

# 走っている代行実行を止められるか（#1882）。**`systemd-run`で起こしたtransient unitを
# `systemctl --user stop`で止める**ので、systemdのユーザーセッションが使えるかで判定する。
#
# **`manual_step_capable`とは分けて申告する。** 代行実行を実行できても、`setsid`の退避経路で
# 起こしたものは止められない。止められないと分かっていれば、画面は押す前に
# 「打ち切り（5分）まで待つことになります」と案内できる。
manual_step_abort_capable() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

# 計画レビュー（G1・#1855）のセッションを起こせるか。**ランチャーが手元にあるかで判定する**
# （`cross_repo_question_capable`と同じ）。
#
# ここを`true`固定にしないことの意味は、この種別ではとりわけ大きい。計画レビューのジョブは
# **計画コメントの投稿を契機に自動で積まれる**ため、ランチャーが無いまま申告すると、
# 計画を出すたびに「未知のジョブ種別です」で失敗したジョブが画面へ並ぶ。
plan_review_capable() {
  if [[ -f "$PLAN_REVIEW_LAUNCHER" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

# リポジトリ全体のコードレビュー（#698）のセッションを起こせるか。**ランチャーが手元にあるかで
# 判定する**（`plan_review_capable`と同じ）。こちらは人が画面から押す種別なので、申告しないと
# ダイアログの選択肢に理由付きで出る（配ってから`failed`で返すより早い）。
code_review_capable() {
  if [[ -f "$CODE_REVIEW_LAUNCHER" ]]; then
    printf 'true'
  else
    printf 'false'
  fi
}

# チェックアウトの更新と自己再起動ができるか（#1875）。**gitリポジトリであることだけを見る。**
#
# 再起動はsystemdの`Restart=always`に任せる（自分で`systemctl restart`を打つと、結果を報告する
# 前に死ぬ）。unitの設定まで確かめないのは、確かめる手段（`systemctl show`）が使えない環境でも
# pollerは動くうえ、`Restart=always`が外れていた場合は「終了したまま上がってこない」という
# 分かりやすい壊れ方をするため。
self_update_capable() {
  if git -C "$CHECKOUT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

# ホストのリソース使用率（#1567）。画面（実行キュー・スマホのホーム）へ出すためだけの申告で、
# **issue-deck側はこの値で何も判定しない**（起動を止めているのは DISPATCH_MAX_SESSIONS と
# 同時実行数だけ）。
#
# **取り方はops-dashboardの`scripts/host-stats/agent.sh`に合わせている。** 同じホストの同じ数字が
# 2つのアプリで食い違うと、どちらを信じてよいか分からなくなる。ホスト全体の監視（サービス・
# プロセス・温度・ネットワーク・履歴）は引き続きあちらの担当で、こちらはCPU・メモリ・SWAP・
# `/`のディスクだけ（SWAPは#1624）。
#
# **どれか1つでも取れなければ何も出力しない**（呼び出し側が`metrics`ごと落とす）。部分的に0が
# 入ると、取れなかった項目が「空いている」と読めてしまう。
collect_host_metrics() {
  local cpu_first cpu_second cpu_percent mem_total_mb mem_used_mb disk_total_gb disk_used_gb
  local swap_total_mb swap_used_mb

  # CPUは瞬間値が取れないため、/proc/stat のアイドル時間と全体の累積を1秒あけて2回読み、
  # その差分から出す。1巡30秒に対する1秒なので、claimの開始が1秒遅れるだけ
  cpu_first="$(awk '/^cpu / { idle = $5 + $6; total = 0; for (i = 2; i <= NF; i++) total += $i; print idle, total; exit }' /proc/stat 2>/dev/null)" || return 1
  [[ -n "$cpu_first" ]] || return 1
  sleep 1
  cpu_second="$(awk '/^cpu / { idle = $5 + $6; total = 0; for (i = 2; i <= NF; i++) total += $i; print idle, total; exit }' /proc/stat 2>/dev/null)" || return 1
  [[ -n "$cpu_second" ]] || return 1
  cpu_percent="$(awk -v first="$cpu_first" -v second="$cpu_second" 'BEGIN {
    split(first, a, " "); split(second, b, " ");
    idle = b[1] - a[1]; total = b[2] - a[2];
    if (total <= 0) exit 1;
    value = (1 - idle / total) * 100;
    if (value < 0) value = 0; if (value > 100) value = 100;
    printf "%.1f", value;
  }')" || return 1
  [[ -n "$cpu_percent" ]] || return 1

  # MemAvailable は「実際に割り当て可能な量」で、キャッシュぶんを空きとして数える。
  # free と MemFree の差で使用量を出すと、キャッシュを使い切ったホストが常に満杯に見える
  mem_total_mb="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  mem_used_mb="$(awk '/^MemTotal:/ { total = $2 } /^MemAvailable:/ { printf "%d", (total - $2) / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  [[ -n "$mem_total_mb" && -n "$mem_used_mb" ]] || return 1

  # SWAP（#1624）。メモリが100%に達したホストは、そこから先の余力がSWAPの増え方にしか出ない。
  # **SwapTotalが0（SWAPを持たない・`swapoff`）でも申告を落とさない**（issue-deck側が0を
  # 「SWAPなし」として行ごと出さない）。メモリと違い、0は壊れた値ではなく正常な構成
  swap_total_mb="$(awk '/^SwapTotal:/ { printf "%d", $2 / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  swap_used_mb="$(awk '/^SwapTotal:/ { total = $2 } /^SwapFree:/ { printf "%d", (total - $2) / 1024; exit }' /proc/meminfo 2>/dev/null)" || return 1
  [[ -n "$swap_total_mb" && -n "$swap_used_mb" ]] || return 1

  # worktreeと開発サーバーで埋まるのは `/` なので、そこ1本だけを見る（#1223・#1525）
  disk_total_gb="$(df -Pk / 2>/dev/null | awk 'NR == 2 { printf "%.1f", $2 / 1048576 }')" || return 1
  disk_used_gb="$(df -Pk / 2>/dev/null | awk 'NR == 2 { printf "%.1f", $3 / 1048576 }')" || return 1
  [[ -n "$disk_total_gb" && -n "$disk_used_gb" ]] || return 1

  jq -n \
    --argjson cpuPercent "$cpu_percent" \
    --argjson memoryUsedMb "$mem_used_mb" \
    --argjson memoryTotalMb "$mem_total_mb" \
    --argjson swapUsedMb "$swap_used_mb" \
    --argjson swapTotalMb "$swap_total_mb" \
    --argjson diskUsedGb "$disk_used_gb" \
    --argjson diskTotalGb "$disk_total_gb" \
    '{cpuPercent: $cpuPercent, memoryUsedMb: $memoryUsedMb, memoryTotalMb: $memoryTotalMb, swapUsedMb: $swapUsedMb, swapTotalMb: $swapTotalMb, diskUsedGb: $diskUsedGb, diskTotalGb: $diskTotalGb}'
}

# 動かしているチェックアウトの版（#1612）。**画面へ出すためだけの申告**で、issue-deck側は
# この値で何も判定しない。
#
# pollerが動かすのは自分と同じチェックアウト（`SCRIPT_DIR`基準）の`reap-sessions.sh`・
# `reap-dev-servers.sh`・ランチャーで、**これを自動で更新する仕組みは無い**。つまり`develop`へ
# マージしただけでは挙動が変わらないのに、変わっていないことに気付く手掛かりがどこにも無かった。
# 2026-08-15には97コミット遅れており、#1454と#1541がどちらもマージ済みなのに一度も
# 効いていなかった（worktreeで`--dry-run`すると直って見えるため、実機との差にも気付けない）。
#
# **ここでやるのは申告だけで、`git pull`はしない**（docs/multi-agent/gates.md）。レビューを
# 経ていないコードが無人で走り出す形にはせず、取り込むかどうかは人が決める。
CHECKOUT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# fetchが固まっても1巡を止めないための上限（秒）。起動の`timeout`と同じ考え方。
CHECKOUT_FETCH_TIMEOUT_SECONDS=60

# 最後にoriginを見た時刻（epoch秒）。**`.git/FETCH_HEAD`のmtimeで見る。**
# gitがfetch・pullのたびに書き直すファイルなので、pollerが打ったfetchも人が手で打ったpullも
# 同じように反映される（poller専用の印を別に持つと、人がpullした直後に「古い」と出る）。
checkout_fetch_epoch() {
  local git_dir fetch_head
  git_dir="$(git -C "$CHECKOUT_DIR" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  fetch_head="$git_dir/FETCH_HEAD"
  [[ -f "$fetch_head" ]] || return 1
  date -r "$fetch_head" +%s 2>/dev/null || return 1
}

# 間隔を過ぎていればoriginを見に行く。**失敗しても何も止めない**（遅れが数えられないだけで、
# その場合は`behindCount`が空のまま申告され、画面には「遅れ不明」と出る）。
maybe_fetch_checkout() {
  ((CHECKOUT_FETCH_INTERVAL_MINUTES > 0)) || return 0
  local last now
  last="$(checkout_fetch_epoch)" || last=0
  now="$(date +%s)"
  ((now - last >= CHECKOUT_FETCH_INTERVAL_MINUTES * 60)) || return 0

  # **標準出力も捨てる。** この関数は申告のJSONを組み立てる途中で呼ばれるため、
  # gitが何か書くとJSONに混ざる。
  if ! timeout "$CHECKOUT_FETCH_TIMEOUT_SECONDS" git -C "$CHECKOUT_DIR" fetch --quiet origin >/dev/null 2>&1; then
    echo "警告: チェックアウトの遅れを数えるためのfetchに失敗しました（$CHECKOUT_DIR）。" >&2
  fi
  return 0
}

# 申告する版を組み立てる。**gitが無い・リポジトリでない・HEADが読めない場合は何も出力しない**
# （呼び出し側が`checkout`ごと落とす）。逆に、ブランチ・遅れ・fetch時刻は取れなくても
# 全体を落とさない。いちばん確実な事実（どのコミットが動いているか）まで消してしまわないため。
collect_checkout_state() {
  command -v git >/dev/null 2>&1 || return 1
  git -C "$CHECKOUT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1

  maybe_fetch_checkout

  local commit branch committed_at upstream behind fetched_epoch fetched_at
  commit="$(git -C "$CHECKOUT_DIR" rev-parse --short HEAD 2>/dev/null)" || return 1
  [[ -n "$commit" ]] || return 1

  # detached HEADでは空になる。**それ自体が異常な状態なので、空のまま申告して画面に出させる**
  branch="$(git -C "$CHECKOUT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  committed_at="$(git -C "$CHECKOUT_DIR" log -1 --format=%cI HEAD 2>/dev/null || true)"

  # 比べる先は追跡ブランチ（通常は`origin/develop`）。**`origin/develop`と決め打ちしない**のは、
  # 別のホスト・別のブランチで動かしたときに「常に大量に遅れている」と出るのを避けるため。
  # 追跡ブランチの設定が無いときだけ`origin/<ブランチ名>`へ落とす。
  upstream="$(git -C "$CHECKOUT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  if [[ -z "$upstream" && -n "$branch" ]] &&
    git -C "$CHECKOUT_DIR" rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null 2>&1; then
    upstream="origin/$branch"
  fi
  behind=""
  if [[ -n "$upstream" ]]; then
    behind="$(git -C "$CHECKOUT_DIR" rev-list --count "HEAD..$upstream" 2>/dev/null || true)"
    [[ "$behind" =~ ^[0-9]+$ ]] || behind=""
  fi

  # 遅れの数字が「いつ時点のものか」。毎巡fetchしないため、これが無いと0の意味が定まらない
  fetched_at=""
  if fetched_epoch="$(checkout_fetch_epoch)"; then
    fetched_at="$(date -u -d "@$fetched_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  fi

  jq -n \
    --arg commit "$commit" \
    --arg branch "$branch" \
    --arg committedAt "$committed_at" \
    --arg fetchedAt "$fetched_at" \
    --argjson behindCount "${behind:-null}" \
    '{commit: $commit, behindCount: $behindCount}
      + (if $branch == "" then {} else {branch: $branch} end)
      + (if $committedAt == "" then {} else {committedAt: $committedAt} end)
      + (if $fetchedAt == "" then {} else {fetchedAt: $fetchedAt} end)'
}

# journaldの1行に載せる版の要約。**画面を開かなくても分かるようにする**（サブPCを直接見る
# ときは、まずここを読むため）。
describe_checkout_state() {
  local checkout="$1"
  [[ -n "$checkout" ]] || return 0
  printf '%s' "$checkout" | jq -r '
    "・スクリプト " + (.branch // "detached") + " " + .commit + "（"
    + (if .behindCount == null then "遅れ不明"
       elif .behindCount == 0 then "最新"
       else "\(.behindCount)コミット遅れ" end)
    + "）"' 2>/dev/null || true
}

announce() {
  local repositories payload live_sessions metrics checkout
  repositories="$(local_repo_list_runnable | jq -R . | jq -s .)"
  # **申告するのは1巡の入口で数えた本数**（#1394）。この後の回収（reap_sessions）で減ったぶんは
  # 次の巡の申告に乗る。画面に出すのは「最後に申告した時点」の数字で、判定そのものは
  # 引き続き claim の直前で数え直す（下の run_once）。回収を待ってから申告する形にすると、
  # 回収が長引いたぶんだけ生存報告が遅れ、応答していないホストとして扱われうる。
  live_sessions="$(count_issue_sessions)"

  # 取れなければ空にし、下で`null`として送る（#1567）。issue-deck側はそれを「申告なし」として
  # 5列をnullへ戻すため、**取れなくなった巡で古い数字が残り続けることはない**
  metrics="$(collect_host_metrics 2>/dev/null)" || metrics=""

  # 集めた使用率から「この巡は起動ジョブを見送るか」を決める（#2095）。**申告と判定を同じ
  # 場所で行う**ので、画面に出る理由と実際の動きが必ず一致する。取れなかった巡は見送らない
  resolve_launch_hold "$metrics" "$MEMORY_HOLD_PERCENT" "$SWAP_HOLD_PERCENT"

  # 動かしているチェックアウトの版（#1612）。取れなければ空にし、下で`null`として送る
  # （issue-deck側はそれを「申告なし」として5列をnullへ戻すため、古い版が残り続けない）
  checkout="$(collect_checkout_state)" || checkout=""

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
  #
  # `metrics`も**画面へ出すためだけの申告**（#1567）。「もう1本起こしてよいか」を判断するのに
  # ops-dashboardを開かなくて済むようにするためのもので、こちらも判定には使わない。
  # 取れなければ`null`（＝申告なし）。
  #
  # `launchHold`は**その使用率を見てpollerが決めた見送り**（#2095）。ここだけは画面へ出すための
  # 写しであると同時に、この巡の実際の動き（`maxJobs: 0`）そのもの。**判定はpoller側のまま**で、
  # issue-deckはこれを受け取って「順番待ちのまま進まない」理由を出す（#1394と同じ形）。
  # 見送っていない巡は`null`。
  #
  # `manualStep`は「手作業アシスタントからの代行実行（#1828）を実行できる」という申告。
  # **`instruction`とも別に持つ。** あちらは走っているセッションの入力欄へ1行送るだけなのに対し、
  # こちらは**シェルでコマンドを実行する**ため、届いた先で起きることの性質が違う。
  #
  # `planReview`は「計画レビュー（G1・#1855）のセッションを起こせる」という申告。
  # **この種別のジョブは人が押さなくても積まれる**（計画コメントの投稿が契機）ため、
  # 対応していないまま申告すると、計画を出すたびに失敗したジョブが画面へ並ぶ。
  #
  # `checkout`も同じく**画面へ出すためだけの申告**（#1612）。**`agentVersion`とは別物**で、
  # あちらは約束を変えたときに手で上げるプロトコル版数、こちらは実際に動いているスクリプトが
  # どのコミットのものかという事実（版数が同じまま97コミット遅れていた、が起きている）。
  payload="$(jq -n \
    --arg host "$HOST_NAME" \
    --argjson repositories "$repositories" \
    --argjson contractVersion "$LOCAL_SESSION_SUPPORTED_CONTRACT_VERSION" \
    --arg agentVersion "$DISPATCH_POLLER_VERSION" \
    --argjson screenshotCapable "$(screenshot_capable)" \
    --argjson maxSessions "$MAX_SESSIONS" \
    --argjson liveSessions "$live_sessions" \
    --argjson crossRepoQuestion "$(cross_repo_question_capable)" \
    --argjson manualStep "$(manual_step_capable)" \
    --argjson manualStepAbort "$(manual_step_abort_capable)" \
    --argjson planReview "$(plan_review_capable)" \
    --argjson codeReview "$(code_review_capable)" \
    --argjson selfUpdate "$(self_update_capable)" \
    --argjson metrics "${metrics:-null}" \
    --argjson launchHold "${LAUNCH_HOLD_JSON:-null}" \
    --argjson checkout "${checkout:-null}" \
    '{host: $host, repositories: $repositories, contractVersion: $contractVersion, agentVersion: $agentVersion, screenshotCapable: $screenshotCapable, sessionControl: true, instruction: true, crossRepoQuestion: $crossRepoQuestion, manualStep: $manualStep, manualStepAbort: $manualStepAbort, planReview: $planReview, codeReview: $codeReview, selfUpdate: $selfUpdate, maxSessions: $maxSessions, liveSessions: $liveSessions, metrics: $metrics, launchHold: $launchHold, checkout: $checkout}')"

  if ! api_call POST /api/dispatch/hosts "$payload"; then
    report_api_failure "ホストの申告に失敗しました"
    return 1
  fi
  echo "申告しました: $HOST_NAME（セッション $live_sessions/$MAX_SESSIONS$(describe_checkout_state "$checkout")） → $(printf '%s' "$repositories" | jq -r 'join(", ")')"
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

# --- worktreeの掃除（#1716）------------------------------------------------------
# マージ済み・作業実績の無いworktreeとローカルブランチを消す。開発サーバー・セッションの回収と
# 同じく**判断は挟まない計器**（docs/multi-agent/gates.md）で、消してよいかの判定はすべて
# `cleanup-worktrees.sh` 側にある。ここは「一定間隔で呼ぶ」だけを持つ。
#
# **これまで実行の起点がどこにも無かった**（#1716）。スクリプトは#1100からあったのに、
# ユーザーcrontabもsystemd timerも無く、`start-issue.sh`は案内を出すだけだったため、サブPCの
# 稼働開始（2026-08-13）から3日で181本・38GBまで溜まり、ルートFSが77%に達した。
# 掃除さえ回れば181本中177本が削除対象になりうる状態だったので、足りなかったのは判定ではなく起点。
#
# **`--all-repos`で全リポジトリを回す**（#2123）。issue-deckだけを掃除していた頃は、汎用
# ランチャーで起こした他リポジトリのworktreeに起点が無く、166本中153本が他リポジトリのまま
# 溜まってルートFSが91%に達した。#1716で足りなかったのが起点なら、ここで足りなかったのは範囲。
#
# **非対話では`--yes`が必須**（付けないと表示だけで終わる）。
WORKTREE_CLEANUP_STAMP="${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck/worktree-cleanup.stamp"
# 掃除が固まっても1巡を止めないための上限（秒）。**この間ポーリングは止まる**（ジョブの取得が
# その分だけ遅れる）が、別プロセスへ逃がすと失敗がjournaldに出ないままになるため、上限付きの
# 同期実行にしている。
#
# 全リポジトリ（19リポジトリ・166本）の`--dry-run`が実測42秒なので、削除を含めても5分あれば
# 足りる。**リポジトリを増やしたらここを見直す**（#2123。1リポジトリあたりfetch1回とgh1回が
# 増える）。
WORKTREE_CLEANUP_TIMEOUT_SECONDS=300

reap_worktrees() {
  ((WORKTREE_CLEANUP_INTERVAL_MINUTES > 0)) || return 0
  [[ -f "$WORKTREE_CLEANER" ]] || return 0

  local last now
  last=0
  if [[ -f "$WORKTREE_CLEANUP_STAMP" ]]; then
    last="$(date -r "$WORKTREE_CLEANUP_STAMP" +%s 2>/dev/null || echo 0)"
  fi
  now="$(date +%s)"
  ((now - last >= WORKTREE_CLEANUP_INTERVAL_MINUTES * 60)) || return 0

  # **走らせる前に印を置く。** 掃除が落ちても次の巡で即座に走り直さないようにする
  # （`gh`の未認証のように毎回失敗する理由だと、30秒ごとに数十秒の走査を繰り返すことになる）。
  mkdir -p "$(dirname "$WORKTREE_CLEANUP_STAMP")" 2>/dev/null || true
  touch "$WORKTREE_CLEANUP_STAMP" 2>/dev/null || true

  echo "worktreeを掃除します（全リポジトリ・間隔 ${WORKTREE_CLEANUP_INTERVAL_MINUTES}分）..."
  # **回収の失敗でポーリングを止めない**（開発サーバー・セッションの回収と同じ扱い）。
  timeout "$WORKTREE_CLEANUP_TIMEOUT_SECONDS" bash "$WORKTREE_CLEANER" --all-repos --yes ||
    echo "Error: worktreeの掃除に失敗しました。" >&2
  return 0
}

# --- node_modules の重複回収（#2124）----------------------------------------------
# npm・yarnのリポジトリはworktreeごとに`node_modules`の実体をコピーするため、worktree1本あたり
# 数百MB〜1GBがそのまま増える（pnpmは自前のストアから張るので増えない）。`generic-start-issue.sh`は
# **これから作る**worktreeを本体からハードリンクで敷くようになったが、既にあるコピーは減らない。
# 実測でサブPCの`~/apps`配下は`node_modules`だけで51.3GB、回収見込みは24.8GiBだった。
#
# 掃除（`reap_worktrees`）と同じく**判断は挟まない計器**で、何をまとめてよいかは
# `hardlink`(util-linux) と `scripts/lib/node-modules-share.sh` が決める。
#
# **掃除と違い同期実行にしない。** 走査は全リポジトリで15分前後かかり、同期で回すとその間
# ジョブの取得が止まる（掃除の上限は5分で、そこに収まらない）。子プロセスの標準出力・標準エラーは
# 引き継ぐので、失敗はこれまでどおりjournaldに残る。多重起動は`dedupe-node-modules.sh`側の
# flockが防ぐ。
NODE_MODULES_DEDUPE_STAMP="${XDG_STATE_HOME:-$HOME/.local/state}/issue-deck/node-modules-dedupe.stamp"

reap_node_modules_duplicates() {
  ((NODE_MODULES_DEDUPE_INTERVAL_MINUTES > 0)) || return 0
  [[ -f "$NODE_MODULES_DEDUPER" ]] || return 0

  local last now
  last=0
  if [[ -f "$NODE_MODULES_DEDUPE_STAMP" ]]; then
    last="$(date -r "$NODE_MODULES_DEDUPE_STAMP" +%s 2>/dev/null || echo 0)"
  fi
  now="$(date +%s)"
  ((now - last >= NODE_MODULES_DEDUPE_INTERVAL_MINUTES * 60)) || return 0

  # **起動する前に印を置く**（掃除と同じ理由）。失敗し続ける状態で30秒ごとに走査を
  # 蒸し返さないようにする。
  mkdir -p "$(dirname "$NODE_MODULES_DEDUPE_STAMP")" 2>/dev/null || true
  touch "$NODE_MODULES_DEDUPE_STAMP" 2>/dev/null || true

  echo "node_modules の重複を回収します（間隔 ${NODE_MODULES_DEDUPE_INTERVAL_MINUTES}分・別プロセス）..."
  setsid bash "$NODE_MODULES_DEDUPER" --yes --quiet &
  return 0
}

# --- コンフリクトの巡回検知 -----------------------------------------------------
# developとコンフリクトしたPRを、issue-deckに巡回して見つけさせる（#2116）。
#
# **GitHub Actions側の自動検知だけでは取りこぼす。** `pull_request(opened)`のイベントが
# 配送されないことがあり（guchi-apps/myroom#191）、安全網の`schedule`も15分間隔の指定に
# 対して実測24〜36分でしか走らない。「作った時点で既にコンフリクトしているPR」がそこへ
# 落ちると、人が画面のボタンを押すまで誰も直しにいかない。
#
# **pollerがやるのは「呼ぶ」ことだけ。** 実際に巡回するかどうかも、どのPRへ何を起動するかも
# issue-deck側が決める（`POST /api/pull-requests/conflict-sweep`）。間隔に達していなければ
# `swept: false`が返って終わる。ここに間隔を持たせないのは、呼ぶ側が増えたときに
# GitHub APIの消費が二重になるのを避けるため。
#
# **失敗しても1巡を止めない**（開発サーバー・セッションの回収と同じ扱い）。
sweep_pull_request_conflicts() {
  if ! api_call POST /api/pull-requests/conflict-sweep '{}'; then
    case "$API_RESPONSE_STATUS" in
      # **404と接続不可は黙って見送る。** 404はサブPCのチェックアウトだけ先に更新されて
      # 本番のissue-deckがまだこの受け口を持っていない期間（更新の順序は運用で決まらない）、
      # 接続不可は直後のジョブ取得が同じ理由で必ず報告する。どちらも30秒ごとに同じ行が
      # 積まれるだけで、新しく分かることが無い。
      404|000) return 0 ;;
      *) report_api_failure "コンフリクトの巡回検知に失敗しました" ;;
    esac
    return 0
  fi

  local swept dispatched
  swept="$(printf '%s' "$API_RESPONSE_BODY" | jq -r '.swept // false' 2>/dev/null || echo false)"
  [[ "$swept" == "true" ]] || return 0

  dispatched="$(printf '%s' "$API_RESPONSE_BODY" | jq -r '.dispatched | length' 2>/dev/null || echo 0)"
  [[ "${dispatched:-0}" -gt 0 ]] || return 0

  # 起動したときだけ出す。**毎巡ログを出さない**（30秒ごとに「異常なし」が積まれると、
  # journalctlで本当に見たい失敗が埋もれる）。
  printf '%s' "$API_RESPONSE_BODY" |
    jq -r '.dispatched[] | "コンフリクト解消を起動しました: \(.repositoryFullName)#\(.pullRequestNumber)（Issue #\(.issueNumber)）"' 2>/dev/null ||
    true
  return 0
}

# --- 本番デプロイ失敗の巡回検知 -------------------------------------------------
# 本番デプロイ（`deploy.yml`）が失敗したまま止まっているリポジトリを、issue-deckに巡回して
# 見つけさせ、追跡用のIssueを起票させる（#2236）。
#
# **失敗はこれまで通知1件と赤いバッジにしか残らなかった。** `deploy-retry.yml`の自動再実行
# （#2134）で直らない失敗は、人が気づいて「本番へ再デプロイ」を押すまで本番が古い版のまま残る。
#
# コンフリクトの巡回検知（上）と同じ形で、**pollerがやるのは「呼ぶ」ことだけ**。実際に
# 巡回するかどうかも、起票するかどうかもissue-deck側が決める。失敗しても1巡を止めない。
sweep_deploy_failures() {
  if ! api_call POST /api/repositories/deploy-failure-sweep '{}'; then
    case "$API_RESPONSE_STATUS" in
      # 404と接続不可を黙って見送る理由はコンフリクトの巡回検知と同じ。
      404|000) return 0 ;;
      *) report_api_failure "デプロイ失敗の巡回検知に失敗しました" ;;
    esac
    return 0
  fi

  local swept actions
  swept="$(printf '%s' "$API_RESPONSE_BODY" | jq -r '.swept // false' 2>/dev/null || echo false)"
  [[ "$swept" == "true" ]] || return 0

  actions="$(printf '%s' "$API_RESPONSE_BODY" | jq -r '.actions | length' 2>/dev/null || echo 0)"
  [[ "${actions:-0}" -gt 0 ]] || return 0

  # 起票・更新・クローズしたときだけ出す（毎巡「異常なし」を積まない）。
  printf '%s' "$API_RESPONSE_BODY" |
    jq -r '.actions[] | "デプロイ失敗Issueを\(if .kind == "created" then "起票" elif .kind == "updated" then "更新" else "クローズ" end)しました: \(.repositoryFullName)#\(.issueNumber)"' 2>/dev/null ||
    true
  return 0
}

# --- ジョブの実行 -------------------------------------------------------------
# ジョブ状態の報告を再送する回数と間隔（#1620）。
#
# **1回の失敗で諦めると、届かなかった報告はタイムアウトの「失敗」になる。** 実際に
# `curl: (28) Connection timed out` が1回起きただけで、tmuxセッションは立っているのに
# ジョブが10分後に「応答が途絶えました」として残った。issue-deck側にも救済を入れている
# （`findSessionsForStaleLaunchJobs`）が、そちらは10分待って初めて効くうえ、セッションを
# 立てない報告（`skipped`・`failed`）は救えない。まずここで届けきる。
#
# 間隔はポーリング間隔（既定30秒）を食い潰さない範囲に収める。再起動・デプロイでの短い断は
# これで越えられ、長く落ちている場合はどのみち次のタイムアウト救済に任せる。
REPORT_RETRY_ATTEMPTS=3
REPORT_RETRY_INTERVAL=5

# issue-deckへ報告した内容を、そのままサブPC側のログにも1行出す（#1228）。
#
# Actions UIに相当するものが無いため、pollerの調査は`journalctl`が入口になる
# （docs/multi-agent/subpc-dispatch.md「ログをどこで見るか」）。それなのに**起動前に
# 早期returnする経路は`report_job`で画面へ報告するだけ**で、手元には`ジョブ <id>: <repo>
# #<番号>`の1行しか出ていなかった。ログだけでは起動したのか見送ったのか判断できず、
# `tmux ls`と突き合わせる必要があった（#1224で実際に起きた）。
#
# **分岐ごとにechoを足すのではなく、報告の入口で出す。** 同じ理由を2か所に書くと片方だけ
# 直したときにずれるうえ、報告のみの分岐は起票時の3か所から20か所以上に増えている
# （`PLAN_REVIEW`の本数上限・`MANUAL_STEP`の照合など）。ここに置けば足し忘れが起きない。
#
# **どちらのストリームへ出すかは、画面へ報告する`status`だけで決める。** 見送り（`skipped`）・
# 成功・実行中は「異常ではないが起きたこと」なので標準出力、`failed`は既存の起動失敗の出力に
# 揃えて標準エラーへ出す。#1228は「不正値・起動不能も標準出力へ」としていたが、それらは画面へ
# `failed`として報告するもので、報告の色とログのストリームが食い違うと突き合わせが要る側に
# 戻ってしまう（journalは標準出力・標準エラーのどちらも同じように残すため、追う分には差が無い）。
#
# **代行実行（`MANUAL_STEP`）の結果はここを通らないし、通してはいけない**（#1228のG1レビュー）。
# pollerが報告するのは`running`までで、成否は`systemd-run`で切り離した別ユニットの
# `scripts/run-manual-step.sh`が自分の`report()`から返す。あちらはコマンドの出力に
# シークレットが混ざりうるためjournalへ書かない取り決めで（同スクリプトの`report()`の
# コメント・docs/multi-agent/subpc-dispatch.md）、ここに揃えに行くとその決まりを破る。
#
# 出すのは1行が基本だが、起動失敗の`message`はランチャー出力の末尾（複数行）をそのまま
# 含む。**そこは要約せず全部出す**（何を直せばよいかが書かれている唯一の出力で、以前も
# 標準エラーへ全文出していた）。
log_job_report() {
  local status="$1" message="${2:-}"

  [[ -n "$message" ]] || return 0
  if [[ "$status" == "failed" ]]; then
    echo "  $message" >&2
  else
    echo "  $message"
  fi
}

report_job() {
  log_job_report "$2" "${3:-}"
  send_job_report "$@"
}

# 報告の送出そのもの。**`report_job`と分けてあるのは、下の`skipped`→`failed`の読み替えで
# 自分を呼び直すため**（ログはもう出しているので、そこから呼ぶとログだけ二重になる）。
send_job_report() {
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

  local attempt
  for (( attempt = 1; attempt <= REPORT_RETRY_ATTEMPTS; attempt++ )); do
    if api_call POST /api/dispatch/report "$payload"; then
      return 0
    fi
    # **再送するのは繋がらなかった場合と5xxだけ。** 401（鍵の不一致）・400（受け口が
    # 知らない値）は何度送っても同じ結果で、下の`skipped`→`failed`の読み替えを遅らせるだけ。
    case "$API_RESPONSE_STATUS" in
      000 | 5??) ;;
      *) break ;;
    esac
    if (( attempt < REPORT_RETRY_ATTEMPTS )); then
      echo "  報告に失敗しました（$status・$attempt/$REPORT_RETRY_ATTEMPTS）。${REPORT_RETRY_INTERVAL}秒後に再送します。" >&2
      sleep "$REPORT_RETRY_INTERVAL"
    fi
  done

  # 受け口が`skipped`（#1229）を知らない版数だと400で弾かれる。**pollerとissue-deckは
  # 別々に更新される**（pollerは本体の作業ツリー＝developを追い、issue-deckの画面はmainから
  # 動く）ため、こちらが先に新しくなる期間が必ずある。そのまま諦めると、起動を見送ったジョブが
  # `RUNNING`のまま残り、10分後にタイムアウトで「応答なし」になる。
  # **見送りは失敗より軽い事実なので、失敗としてなら報告できる間はそちらで報告する。**
  if [[ "$status" == "skipped" && "$API_RESPONSE_STATUS" == "400" ]]; then
    echo "  受け口が skipped を受け付けないため failed で報告します（issue-deckの版数が古い）" >&2
    send_job_report "$job_id" failed "$message" "$session"
    return 0
  fi

  # **報告の失敗で処理を止めない。** issue-deckが単一障害点にならないようにする取り決め
  # （/api/progress と同じ）。ここまで来た報告はissue-deck側のタイムアウトが拾う。起動が
  # 成功していた場合は、そのときセッションが動いているかを見て成功として畳まれる（#1620）。
  # 再送を打ち切った場合（401など）と全部使い切った場合を区別できるよう、実際の試行回数を出す
  report_api_failure "ジョブ状態の報告に失敗しました（$job_id → $status。$(( attempt > REPORT_RETRY_ATTEMPTS ? REPORT_RETRY_ATTEMPTS : attempt ))回試行）"
}

tmux_session_names() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null | sort || true
}

# --- tmuxサーバーのcgroup（#1935）------------------------------------------------
# **tmuxサーバーはpollerとは別のcgroupで起こす。**
#
# unitに`KillMode`の指定は無く、systemdの既定は`KillMode=control-group`なので、停止処理では
# cgroupの残り全員にSIGTERMが飛ぶ。何もしなければtmuxサーバーを最初に起こすのはpollerが呼んだ
# ランチャーの`tmux new-session`で、サーバーはpollerと同じcgroupに入る。その結果
# `systemctl --user restart`（と異常終了→`Restart=always`での復帰）のたびに、走っている実装
# セッションが全部落ちていた（2026-08-18の再起動では6本→0本。#1935）。
#
# **サーバーさえ別のcgroupへ出せば、配下のセッションはまとめて巻き添えから外れる。** paneの
# プロセスはtmuxサーバーの子として生まれるためで、起動を仲介するランチャー（pollerの子）は
# そのままでよい——`tmux new-session`は既に動いているサーバーに作らせるだけだから。
#
# 起こし方は手作業の代行実行（#1828）と同じ`systemd-run --user`だが、あちらの`--collect --unit=`
# （service）ではなく**scope**を使う。serviceはsystemdがコマンドを起こすもので、tmuxのように
# 自分でdaemon化するプロセスは主プロセスの追跡に約束事が要る。scopeは「このプロセスを別のunitに
# 入れて動かす」だけなので、daemon化した後もサーバーがそのcgroupに残り、残っている間だけ
# scopeも生き続ける。
#
# `set-option -s exit-empty off`が要る。既定ではセッションが1本も無いサーバーは即座に終了する
# ため、`start-server`だけでは起こした端からscopeごと消える。
#
# **既に動いているサーバーのcgroupは後から変えられない。** 置き直せるのはサーバーが動いて
# いない隙だけなので、ここでは「無ければ起こす」だけを行い、pollerと同じcgroupにいるサーバーを
# 見つけた場合は警告に留める（走っているセッションが全部終わってサーバーが落ちれば、次の起動で
# 自然に移る）。
TMUX_SERVER_SCOPE_UNIT="issue-deck-tmux-server"
TMUX_SERVER_CGROUP_WARNED=0

# cgroup v2のパス（`/proc/<pid>/cgroup`の`0::`行の3列目）。読めなければ空を返す。
process_cgroup_path() {
  awk -F: '$1 == "0" { print $3; exit }' "/proc/$1/cgroup" 2>/dev/null || true
}

# 走っているtmuxサーバーがpollerと同じcgroupにいたら警告する。**プロセスごとに1度だけ**
# （毎巡出すとjournalが埋まり、本来見たい失敗理由が読めなくなる）。
warn_if_tmux_server_shares_cgroup() {
  [[ "$TMUX_SERVER_CGROUP_WARNED" -eq 0 ]] || return 0
  local server_pid ours theirs
  server_pid="$(tmux display-message -p '#{pid}' 2>/dev/null || true)"
  [[ "$server_pid" =~ ^[1-9][0-9]*$ ]] || return 0
  ours="$(process_cgroup_path "$$")"
  theirs="$(process_cgroup_path "$server_pid")"
  [[ -n "$ours" && "$ours" == "$theirs" ]] || return 0
  TMUX_SERVER_CGROUP_WARNED=1
  echo "警告: 動いているtmuxサーバー（PID $server_pid）がpollerと同じcgroupにいます（#1935）。" >&2
  echo "  この状態のまま systemctl --user restart で再起動すると、走っている実装セッションが" >&2
  echo "  巻き添えで落ちます。セッションが1本も無くなってサーバーが落ちれば、次の起動から" >&2
  echo "  別のcgroup（$TMUX_SERVER_SCOPE_UNIT.scope）へ移ります。" >&2
}

ensure_tmux_server_scope() {
  # サーバーが動いていれば何もしない。**セッションが0本でも成功する**ので、
  # 「サーバーが動いているか」の判定にそのまま使える（動いていなければ非0で終わる）。
  if tmux list-sessions >/dev/null 2>&1; then
    warn_if_tmux_server_shares_cgroup
    return 0
  fi

  if ! command -v systemd-run >/dev/null 2>&1; then
    echo "警告: systemd-run が無いため、tmuxサーバーはpollerと同じcgroupで起こされます（#1935）。" >&2
    return 0
  fi

  if timeout 30 systemd-run --user --quiet --scope --collect --unit="$TMUX_SERVER_SCOPE_UNIT" \
    tmux start-server ';' set-option -s exit-empty off >/dev/null 2>&1; then
    echo "tmuxサーバーをpollerとは別のcgroupで起こしました（$TMUX_SERVER_SCOPE_UNIT.scope）。"
    return 0
  fi

  # 起こせなくてもセッションの起動自体は続けられる（ランチャーの`tmux new-session`が従来どおり
  # pollerのcgroupでサーバーを起こす）。**そのぶん巻き添えの条件は元に戻る**ので理由を残す。
  echo "警告: tmuxサーバーを別のcgroup（$TMUX_SERVER_SCOPE_UNIT.scope）で起こせませんでした（#1935）。" >&2
  return 0
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

# セッションの owner/repo を復元する。第1引数はtmuxのセッション名、第2引数はそこから
# 切り出したリポジトリ名（`<リポジトリ名>-issue-<番号>`の前半）。
#
# **まず状態ファイル（`lib/session-state.sh`の記述子）の`repository=`を見る。** 起動した
# ランチャー自身が書いた値なので、名前から推測するより確実で、`local-repos.conf`に載っていない
# リポジトリでも取れる。横断質問セッション（#1454）の記録先`guchi-apps/question`は
# **cloneも`local-repos.conf`への記載も要らない設計**（docs/multi-agent/subpc-dispatch.md
# 「記録先リポジトリはcloneされていなくてよい」）のため、対応表だけを見ていると質問セッションが
# まるごと報告から落ち、#1465の「まだ開始していません」も一度も働かなかった（#1537）。
#
# 記述子が無い・壊れている場合だけ、従来どおり`local-repos.conf`の一覧の basename と
# 突き合わせる（人が手で立てたセッション・古いランチャーで起きたセッション）。
# **候補が2件以上あるときは何も出力しない。** 別ownerに同名のリポジトリがあると、どちらのIssueか
# 名前だけでは決められず、当てずっぽうに選ぶと**無関係なIssueへ引き上げのコメントを投稿する**。
resolve_session_repository() {
  local session="$1" repo_name="$2" full_name matched="" count=0 descriptor recorded

  descriptor="$(session_state_descriptor_file "$session" 2>/dev/null || true)"
  if [[ -n "$descriptor" && -f "$descriptor" ]]; then
    recorded="$(session_state_field "$descriptor" repository 2>/dev/null || true)"
    # 状態ファイルはいつでも書き換えられうるので、owner/repo の形だけは必ず確かめる
    # （壊れた値をそのままIssueの宛先にしない。`source`しないのと同じ用心）。
    if [[ "$recorded" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
      printf '%s\n' "$recorded"
      return 0
    fi
  fi

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

# 畳む予定（#1817）。回収スクリプト（`reap-sessions.sh`）が「畳む条件は揃っていて、あとは猶予が
# 経つのを待っているだけ」と判定したセッションにだけ置く状態ファイル（`.reap`）を、そのまま
# 報告に載せる。
#
# **ここでは判定をしない。** 判定材料（worktreeがcleanか・push済みか・Issueとの関係）は
# 回収スクリプトが持っており、pollerは運ぶだけ（`docs/multi-agent/gates.md`「計器」）。
# 読めない・無い場合は両方nullで、画面には何も出ない。
#
# **報告は毎巡`reap_sessions`の後に行う**ので、載るのは常にその巡の結論になる。
session_reap_json() {
  local session="$1" line at reason iso
  line="$(session_state_read_reap "$session" 2>/dev/null || true)"
  if [[ ! "$line" =~ ^([0-9]+)[[:space:]]+([A-Z_]+)$ ]]; then
    printf '{"reapAt":null,"reapReason":null}'
    return 0
  fi
  at="${BASH_REMATCH[1]}"
  reason="${BASH_REMATCH[2]}"
  iso="$(date -u -d "@$at" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  if [[ -z "$iso" ]]; then
    printf '{"reapAt":null,"reapReason":null}'
    return 0
  fi
  jq -nc --arg at "$iso" --arg reason "$reason" '{reapAt: $at, reapReason: $reason}'
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

    # owner/repo を戻せないセッションは送らない（他リポジトリ・曖昧な同名）。
    full_name="$(resolve_session_repository "$session_name" "$repo_name")" || continue

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
      --argjson reap "$(session_reap_json "$session_name")" \
      '{tmuxSessionName: $tmuxSessionName, repositoryFullName: $repositoryFullName,
        issueNumber: $issueNumber, paneDead: $paneDead, paneDeadStatus: $paneDeadStatus,
        claudeStarting: $claudeStarting} + $reap')")
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

# 計画レビュー（G1・#1855）のセッション名。**`-issue-`の規約からは外してある。**
#
# 実装セッションと同じ形にすると、`report_sessions`（セッションの報告）・`count_issue_sessions`
# （本数の計上）・停止／終了の突き合わせがすべて拾ってしまい、**計画レビューを実装セッションと
# 取り違えて畳む**ことになる。計画レビューは計画を出したセッションと同じIssueに対して、
# そのセッションが生きている最中に走る。組み立て方は`scripts/start-plan-review.sh`と揃える。
plan_review_session_name() {
  local repo="$1" issue_number="$2"
  printf '%s' "${repo//[^A-Za-z0-9_-]/-}-plan-review-$issue_number"
}

# コードレビュー（#698）のセッション名。**`-issue-`の規約からは外してある**（計画レビューと
# 同じ理由）。組み立て方は`scripts/start-code-review.sh`と揃える。
code_review_session_name() {
  local repo="$1" issue_number="$2"
  printf '%s' "${repo//[^A-Za-z0-9_-]/-}-code-review-$issue_number"
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
#
# 第2引数は許可する状態イベント（`|`区切り。省略時は`Stop`だけ）。**広げてよいのは
# `working`まで**で、APIエラーで中断したセッションの自動再開（#1971）だけがそれを渡す。
# あちらは`Stop`フックが飛ばないまま止まるため`working`のまま残り、しかし転記の末尾が
# APIエラーであることを別途確かめてから来る。`permission_prompt`は**どの経路でも許可しない**
# （事故が起きたのはまさにこの状態）。
instruction_ready() {
  local session="$1" allowed="${2:-Stop}" event last_event pane input_line rest

  # 1a. 状態ファイル（#1219・#1357）。**最後のイベントが`$allowed`に含まれるときだけ送る**
  # （既定は`Stop`だけ）。`permission_prompt`は承認プロンプト・`AskUserQuestion`の表示中で、
  # 事故が起きたのはまさにこの状態。`working`は作業中。
  # **記録が無いときも送らない**（判定材料が無い＝確かめられない）。
  if ! event="$(session_state_read_event "$session")" || [[ -z "$event" ]]; then
    echo "セッションの状態が記録されていないため送りませんでした（フックが動いていない可能性があります）"
    return 1
  fi
  last_event="${event##* }"
  if [[ "$last_event" == "permission_prompt" ]]; then
    echo "承認プロンプトまたは選択フォームの表示中のため送りませんでした（答えるのはRemote Controlから行ってください）"
    return 1
  fi
  if [[ ! "$last_event" =~ ^($allowed)$ ]]; then
    echo "セッションが作業中のため送りませんでした（最後のイベント: $last_event）"
    return 1
  fi

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
#
# **ジョブに依らない**（#1971でAPIエラーからの自動再開も同じ経路を
# 通すため切り出した）。第3引数は`instruction_ready`へ渡す「許可する状態イベント」。
#
# 返り値: 0=送った / 1=見送り（安全機構が正常に止めた）/ 2=送れなかった（異常）
# 1・2のときは理由を標準出力へ1行で返す。**呼び出し元が報告の形（ジョブ／ログ）を決める。**
deliver_session_instruction() {
  local session="$1" body="$2" allowed="${3:-Stop}" reason

  if [[ -z "$body" ]]; then
    echo "追加指示の本文が空です"
    return 2
  fi
  # 受け口（`parseSessionInstruction`）と同じ検証を重ねる。**ここが最後に端末へ渡す場所**なので、
  # issue-deck側で検証済みでも改めて確かめる（多層防御。セッション名の突き合わせと同じ立場）。
  if [[ "$body" == *$'\n'* || "$body" =~ [[:cntrl:]] ]]; then
    echo "追加指示の本文に改行または制御文字が含まれています"
    return 2
  fi
  if ((${#body} > 500)); then
    echo "追加指示の本文が長すぎます（${#body}文字）"
    return 2
  fi

  # 段1: 状態確認
  if ! reason="$(instruction_ready "$session" "$allowed")"; then
    # **失敗ではなく見送り。** 安全機構が正常に働いた結果で、何も壊れていない（#1229と同じ扱い）。
    echo "$reason"
    return 1
  fi

  # 段2: 本文のみ送出（Enterは送らない）。`-l`はリテラル送出で、`--`以降を値として扱わせる
  # （`-l`が無いと`Enter`のようなキー名として解釈されうる）。
  if ! tmux send-keys -t "=$session:" -l -- "$body" 2>/dev/null; then
    echo "追加指示の本文を送れませんでした: $session"
    return 2
  fi

  # 段3: 反映の再確認。**ここで止まったら追加のキーは一切送らない。** 本文がどこへ入ったのか
  # 分からない状態で消しにいく（`C-u`など）のは、事故の元をもう1つ増やすことになる。
  if ! instruction_reflected "$session" "$body"; then
    echo "本文が入力欄に反映されたことを確認できなかったため、Enterを送っていません。入力欄に文字が残っている可能性があります（tmux attach -t $session で確認してください）"
    return 2
  fi

  # 段4: 確定キーを別送
  if ! tmux send-keys -t "=$session:" Enter 2>/dev/null; then
    echo "本文は入力欄に入りましたが、確定キーを送れませんでした（tmux attach -t $session で確認してください）"
    return 2
  fi

  return 0
}

# 画面から積まれた追加指示（`INSTRUCTION`）を1件送り、結果をジョブとして報告する。
send_session_instruction() {
  local job_id="$1" session="$2" body="$3" message status=0

  message="$(deliver_session_instruction "$session" "$body")" || status=$?
  case "$status" in
    0)
      report_job "$job_id" succeeded "追加指示を送りました: $session" "$session"
      ;;
    1)
      # 理由はジョブの`message`として画面に出るので、送り直すかどうかは人が判断できる。
      # **前置き（「追加指示を見送りました」）は付けない**（#1228のG1レビュー）。画面は
      # 状態ラベルとして既に「送信を見送りました」を出すため（`dispatch-job.ts`の
      # `SKIPPED`）、`message`側にも付けると同じことを2回言う表示になる。ログでは直前の
      # 「ジョブ <id>: <repo> #<番号>（INSTRUCTION）」の行が文脈を持っている。
      report_job "$job_id" skipped "$message" "$session"
      ;;
    *)
      report_job "$job_id" failed "$message" "$session"
      ;;
  esac
  return 0
}

# --- APIエラーで中断したセッションの自動再開（#1971）-----------------------------
# Claude Codeがサーバー側の一時エラー（529 Overloaded など）を再試行しきると、そのturnは
# `API Error: 529 Overloaded. ...` の表示で打ち切られ、**`Stop`フックが飛ばないまま**入力欄へ
# 戻る。誰にも通知されず、状態ファイルは`working`のまま止まり、回収も追加指示も効かない。
# 2026-08-18には6セッションが5時間半それで止まっていた（`lib/session-resume.sh`の冒頭を参照）。
#
# **ここはCLAUDE.md「監視・計画レビューを行う実行体の禁止事項」の3つ目の例外**にあたる。
# 事故（選択フォームの表示中に本文＋Enterを送り、勝手に回答済みになった）を再発させないため、
# 次の3つを同時に満たす形でだけ開けている。
#
#   1. 送る本文は固定（`SESSION_RESUME_BODY`）。**状況を読んで返事を組み立てない**
#   2. 送る経路は人が押したときと同じ3段階プロトコル（`deliver_session_instruction`）。
#      承認プロンプト・選択フォームの表示中、処理中、入力欄に打ちかけがある場合は送らない
#   3. 送ってよいのは、**転記の末尾がAPIエラーである**ことを確かめられたセッションだけ
#
# 上限（既定3回）を使い切ったら送るのをやめ、Signalyへ1度だけ通知して人へ渡す。

# 中断したセッションをSignalyへ引き上げる（#1971）。**通知の文面と送り先を持つのは
# `session-notify.sh`1箇所**なので、pollerは合成したフックJSONを渡すだけにする。
# `session_id`を載せるのは、向こうがRemote ControlのURLを引くのに使うため。
notify_session_interrupted() {
  local session="$1" repo_name="$2" issue_number="$3" full_name="$4" detail="$5"
  local session_id hook_json
  [[ -x "$NOTIFY_SCRIPT" ]] || return 0
  session_id="$(session_transcript_record_field "$session" sessionId 2>/dev/null || true)"
  hook_json="$(jq -nc --arg id "$session_id" --arg detail "$detail" \
    '{hook_event_name: "SessionInterrupted", session_id: $id, interrupt_detail: $detail}')" || return 0
  printf '%s' "$hook_json" |
    SESSION_NOTIFY_TMUX_SESSION="$session" "$NOTIFY_SCRIPT" "$issue_number" "$repo_name" "$full_name" ||
    true
  return 0
}

resume_interrupted_sessions() {
  local session_name repo_name issue_number full_name message status attempts

  [[ "${SESSION_RESUME_ENABLED:-1}" != "0" ]] || return 0

  while IFS= read -r session_name; do
    [[ -n "$session_name" ]] || continue
    # 実装セッションだけを対象にする。計画レビュー・横断質問はフックの状態ファイルを持たず
    # （名前が`-issue-`の規約から外れている）、段1で必ず弾かれる。
    [[ "$session_name" =~ ^(.+)-issue-([1-9][0-9]*)$ ]] || continue
    repo_name="${BASH_REMATCH[1]}"
    issue_number="${BASH_REMATCH[2]}"

    if ! session_resume_interrupted "$session_name"; then
      # 自力で動き出した（または最初から止まっていない）。**次に別の理由で止まったときに
      # 前回の回数を引きずらないよう、ここで消す。**
      session_state_clear_resume "$session_name"
      continue
    fi

    if session_resume_exhausted "$session_name"; then
      session_resume_notified "$session_name" && continue
      full_name="$(resolve_session_repository "$session_name" "$repo_name" || true)"
      echo "APIエラーからの自動再開をあきらめました（上限 ${SESSION_RESUME_MAX_ATTEMPTS} 回）: $session_name"
      notify_session_interrupted "$session_name" "$repo_name" "$issue_number" "${full_name:-}" \
        "自動再開を${SESSION_RESUME_MAX_ATTEMPTS}回試しましたが再開できませんでした。"
      session_resume_record_notified "$session_name"
      continue
    fi

    session_resume_due "$session_name" || continue

    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "--dry-run のため再開しません（APIエラーで中断: $session_name）"
      continue
    fi

    # **許可する状態イベントに`working`を足すのはここだけ。** 中断したセッションは`Stop`が
    # 飛ばないまま`working`で止まっているため、既定のままでは自分の中断を直せない。
    status=0
    message="$(deliver_session_instruction "$session_name" "$SESSION_RESUME_BODY" 'Stop|working')" || status=$?
    session_resume_record_attempt "$session_name"
    attempts="$(session_resume_read_state "$session_name" | awk '{print $2}')"
    case "$status" in
      0) echo "APIエラーで中断していたため再開しました（${attempts}/${SESSION_RESUME_MAX_ATTEMPTS}回目）: $session_name" ;;
      1) echo "APIエラーで中断していますが再開を見送りました: $session_name: $message" ;;
      *) echo "APIエラーで中断していますが再開できませんでした: $session_name: $message" ;;
    esac
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
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

  report_job "$job_id" succeeded "$action を実行しました: $session" "$session"
  return 0
}

# 手作業の代行実行（#1828）。承認された1手順ぶんのコマンドを、このホストで実行する。
#
# **届いたコマンドをそのまま実行しない。** GitHubから手作業Issueの本文を読み直し、
#
#   1. `71.manual-step` ラベルが付いていること
#   2. 受け取ったコマンドが**その本文にそのまま含まれる**こと
#
# の2つを確かめてから実行する。issue-deck側（`enqueueManualStepJob`）も本文から抽出し直した
# ものだけをジョブに載せているので、**同じ照合を独立に2回行う**形になる。DBだけ、あるいは
# issue-deckだけを握られても、本文に無いコマンドはここで止まる。
#
# **実行そのものは別プロセスへ逃がす**（`run-manual-step.sh`）。サブPCの手作業で最も多いのが
# 「`git pull`してpollerを再起動する」で、pollerのcgroupの中で実行すると自分ごと殺されて
# 結果を返せない。`systemd-run --user --collect --unit=...`で別のcgroupへ出す。
# チェックアウトを最新へ追随させ、pollerを畳む（#1875）。
#
# **`ssh`して`git pull && systemctl restart`していた手作業**（#1858・#1867）の置き換え。
# pollerが自分から`git pull`しない設計（人が取り込むかを決める）は崩さず、**画面で押された
# ときだけ**動く経路としてここに置く。
#
# **報告してから終了する。** 自分で`systemctl --user restart`を打つと、報告が届く前にプロセスが
# 死んで、画面には「実行中」のまま残る。終了だけしてsystemdの`Restart=always`に拾わせれば、
# 結果を返したうえで新しい版で上がり直せる。
run_self_update_job() {
  local job_id="$1"

  echo "チェックアウトを更新します（$CHECKOUT_DIR）..."

  # **作業ツリーが汚れていたら触らない。** 手で試した変更を巻き込んで消しうるため、
  # 強制せずに人へ返す
  if [[ -n "$(git -C "$CHECKOUT_DIR" status --porcelain 2>/dev/null)" ]]; then
    report_job "$job_id" failed "作業ツリーに未コミットの変更があります。手元で確認してください。"
    return 0
  fi

  local before after out
  before="$(git -C "$CHECKOUT_DIR" rev-parse --short HEAD 2>/dev/null || true)"

  # **`--ff-only`。** マージコミットを作らず、分岐していれば失敗として返す
  if ! out="$(timeout 120 git -C "$CHECKOUT_DIR" pull --ff-only 2>&1)"; then
    report_job "$job_id" failed \
      "git pull --ff-only に失敗しました: $(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    return 0
  fi

  after="$(git -C "$CHECKOUT_DIR" rev-parse --short HEAD 2>/dev/null || true)"

  if [[ "$before" == "$after" ]]; then
    report_job "$job_id" succeeded "既に最新でした（$after）。再起動します。"
  else
    report_job "$job_id" succeeded "$before → $after へ更新しました。再起動します。"
  fi

  # **終了せず、`exec`で新しいスクリプトへ入れ替える**（#1927）。
  #
  # unitは既定の`KillMode=control-group`で、mainプロセスが終わるとsystemdは停止処理として
  # **cgroupの残り全員にSIGTERMを送る**。このcgroupにはpollerが起こしたtmuxサーバーと
  # 実装セッションが入っているため、`exit`で畳むと更新のたびに走っている実装セッションが
  # 全部落ちる（2026-08-18の`systemctl --user restart`では6本→0本になっている）。
  # 同じPIDのまま`exec`すればsystemdから見て何も起きておらず、停止処理も走らない。
  echo "更新を反映するため、新しいスクリプトへ入れ替えます（同じプロセスのまま）。"
  exec /usr/bin/env bash "${BASH_SOURCE[0]}" ${POLLER_ARGV[@]+"${POLLER_ARGV[@]}"}
}

run_manual_step_job() {
  local job_id="$1" owner="$2" repo="$3" issue_number="$4" command="$5"
  local body payload_file unit

  if [[ -z "$command" ]]; then
    report_job "$job_id" failed "実行するコマンドが空です。"
    return 0
  fi
  if [[ ! -f "$MANUAL_STEP_RUNNER" ]]; then
    report_job "$job_id" failed "代行実行のスクリプトがありません（$MANUAL_STEP_RUNNER）。"
    return 0
  fi

  # **確かめられなければ実行しない**（`gh`が無い・未認証・Issueを読めない）。
  # 判定材料が無いときは実行しない側へ倒す（この仕組み全体で一貫している向き）。
  if ! body="$(gh issue view "$issue_number" --repo "$owner/$repo" --json body,labels 2>/dev/null)"; then
    report_job "$job_id" skipped "GitHubから手作業Issueの本文を読めなかったため実行しませんでした。"
    return 0
  fi
  if [[ "$(printf '%s' "$body" | jq -r '[.labels[].name] | index("71.manual-step") // "" ')" == "" ]]; then
    report_job "$job_id" skipped "対象が手作業Issue（71.manual-step）ではないため実行しませんでした。"
    return 0
  fi
  # 本文に**そのまま含まれる**ことだけを見る（本文の解析はissue-deck側の仕事で、こちらでは
  # もう一度やらない。ここで見たいのは「本文に無いコマンドが混ざっていないか」の一点）
  if ! printf '%s' "$body" | jq -r '.body // ""' | grep -qF -- "$command"; then
    report_job "$job_id" skipped \
      "実行するコマンドが手作業Issueの本文と一致しないため実行しませんでした（本文が変わった可能性があります）。"
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  --dry-run のため実行しません（MANUAL_STEP → $owner/$repo #$issue_number）"
    echo "  照合は通りました（本文に同じコマンドがあります）"
    return 0
  fi

  # **コマンドはargvに載せずファイルで渡す**（`ps`で他のユーザーからも見えるため）。
  # 読んだ側が消す。
  payload_file="$(mktemp -t issue-deck-manual-step-job.XXXXXX)"
  chmod 600 "$payload_file"
  jq -n --arg jobId "$job_id" --arg command "$command" '{jobId: $jobId, command: $command}' \
    >"$payload_file"

  # 実行を始めたことを先に伝える（届くまで最大1巡ぶん遅れるので、画面が黙る時間を短くする）
  report_job "$job_id" running "サブPCで実行しています"

  unit="issue-deck-manual-step-$job_id"
  if command -v systemd-run >/dev/null 2>&1 &&
    systemd-run --user --quiet --collect --unit="$unit" \
      /bin/bash -lc "$MANUAL_STEP_RUNNER $(printf '%q' "$payload_file")" 2>/dev/null; then
    echo "  代行実行を開始しました（$unit）"
    return 0
  fi

  # systemd-runが使えない環境向けの退避経路。**pollerを再起動する手順ではここは巻き添えになる**
  # （そのときは結果が返らず、ジョブはタイムアウトする）。それでも実行できない状態よりはよい。
  echo "  systemd-runが使えないため、切り離したプロセスとして実行します" >&2
  setsid nohup /bin/bash -lc "$MANUAL_STEP_RUNNER $(printf '%q' "$payload_file")" \
    >/dev/null 2>&1 &
  disown
  return 0
}

# 走っている代行実行を止める（#1882）。
#
# 代行実行は`systemd-run --user --collect --unit=issue-deck-manual-step-<ジョブID>`で
# 起こしている。**ユニット名は受け取ったジョブidから組み立て直す**ので、この経路で任意の
# ユニットを止めることはできない（idの形も確かめる）。
#
# 止めると`run-manual-step.sh`ごと落ちるため、**そのジョブの結果は返らない**。issue-deck側は
# heartbeatの途絶で`TIMEOUT`にするか、画面が中断として扱う。ここでは中断ジョブ自身の成否だけを返す。
abort_manual_step_job() {
  local job_id="$1" target_job_id="$2" unit

  if [[ -z "$target_job_id" ]]; then
    report_job "$job_id" failed "止める対象のジョブが指定されていません。"
    return 0
  fi
  # cuid（英数字）以外は受け付けない。**そのままユニット名になる値**なので形を確かめる
  if [[ ! "$target_job_id" =~ ^[A-Za-z0-9_-]+$ ]]; then
    report_job "$job_id" failed "止める対象のジョブidが不正です。"
    return 0
  fi

  unit="issue-deck-manual-step-$target_job_id"
  if ! command -v systemctl >/dev/null 2>&1; then
    report_job "$job_id" failed "systemctlが無いため、走っているコマンドを止められません。"
    return 0
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  --dry-run のため停止しません（$unit）"
    return 0
  fi

  # **既に終わっていた場合も失敗にしない。** 止めたい状態にはなっている（`is-active`で確かめる）
  if ! systemctl --user is-active --quiet "$unit" 2>/dev/null; then
    report_job "$job_id" succeeded "走っているコマンドは既に終わっていました。"
    return 0
  fi

  if systemctl --user stop "$unit" >/dev/null 2>&1; then
    # **このechoは残す**（#1228のG1レビュー）。報告と同じことを言っているように見えるが、
    # 止めたユニット名が出るのはここだけで、報告の文言（画面に出る）は変えない。
    echo "  代行実行を中断しました（$unit）"
    report_job "$job_id" succeeded "走っているコマンドを止めました。"
    return 0
  fi
  report_job "$job_id" failed "走っているコマンドを止められませんでした（$unit）。"
  return 0
}

# ジョブを1件実行する。
#
# 起動できたかどうかは、**起動の前後でtmuxのセッション一覧を比べて増分を見る**。
# セッション名の付け方は各リポジトリの start-issue.sh 側の裁量で、こちらで先読みして
# 組み立てると規約がずれた瞬間に「起動したのに失敗と報告する」誤判定になる。
run_job() {
  local job_json="$1"
  local job_id owner repo full_name issue_number kind requested_session instruction command
  job_id="$(printf '%s' "$job_json" | jq -r '.id')"
  full_name="$(printf '%s' "$job_json" | jq -r '.repositoryFullName')"
  issue_number="$(printf '%s' "$job_json" | jq -r '.issueNumber')"
  # 古いissue-deckは`kind`を返さない。**その場合は従来どおりの起動ジョブとして扱う**
  kind="$(printf '%s' "$job_json" | jq -r '.kind // "LAUNCH"')"
  requested_session="$(printf '%s' "$job_json" | jq -r '.tmuxSessionName // ""')"
  # 追加指示の本文（#1012）。`INSTRUCTION`以外では空
  instruction="$(printf '%s' "$job_json" | jq -r '.instruction // ""')"
  # 代行実行するコマンド（#1828）。`MANUAL_STEP`以外では空
  command="$(printf '%s' "$job_json" | jq -r '.command // ""')"
  owner="${full_name%%/*}"
  repo="${full_name#*/}"

  echo "ジョブ $job_id: $full_name #$issue_number（$kind）"

  # チェックアウトの更新（#1875）。**Issueに紐づかない**ため、owner/repo/issue_numberは
  # 埋め草が入っている（issue-deck#0）。参照しない。
  #
  # **下の`local_session_validate_target`より前に置く**（#1927）。あちらはIssue番号に
  # `^[1-9][0-9]*$`を求めるため、埋め草の`0`が必ず弾かれ、この種別は届いた全件が
  # 「Issue番号が不正です」で失敗していた。画面の「更新して再起動」は押しても何も起きず、
  # 失敗はキューのどこにも出ない（`SELF_UPDATE`は起動ジョブでも制御ジョブでもないため）ので、
  # 効いていないことに気付く手掛かりが無かった。
  if [[ "$kind" == "SELF_UPDATE" ]]; then
    run_self_update_job "$job_id"
    return 0
  fi

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
    launch_and_report "$job_id" "$(expected_session_name "$repo" "$issue_number")" \
      "横断質問セッションを起動しています" \
      bash "$QUESTION_LAUNCHER" "$owner" "$repo" "$issue_number"
    return 0
  fi

  # 計画レビュー（G1・#1855）。**`local_repo_check`は通さない**（版数の契約は実装セッション用で、
  # こちらは読むだけ）。cloneが無い場合はランチャー側が理由を出して落ちる。
  #
  # **重複起動の判定に使うセッション名が実装セッションとは違う**（`<repo>-plan-review-<番号>`）。
  # 実装セッションの名前で見ると、計画を出したセッションが動いている間はレビューが必ず
  # 「起動済みのため見送り」になる——それはこの機能が働くべき瞬間そのもの。
  if [[ "$kind" == "PLAN_REVIEW" ]]; then
    if [[ ! -f "$PLAN_REVIEW_LAUNCHER" ]]; then
      report_job "$job_id" failed "計画レビューのランチャーがありません（$PLAN_REVIEW_LAUNCHER）。"
      return 0
    fi
    # **本数の上限はここでしか見られない**（#1855）。計画レビューのセッションは
    # `count_issue_sessions`に数えられず、ジョブも起動した時点で閉じるため、
    # `DISPATCH_MAX_SESSIONS`とは独立に積み上がる。**失敗ではなく見送り**として報告する
    # （ガードが正常に働いた結果で、何も壊れていない。#1229と同じ扱い）。見送った計画は
    # 画面の「計画をレビュー」から起こし直せる
    local live_reviews
    live_reviews="$(count_plan_review_sessions)"
    if [[ "$MAX_PLAN_REVIEWS" -gt 0 && "${live_reviews:-0}" -ge "$MAX_PLAN_REVIEWS" ]]; then
      report_job "$job_id" skipped \
        "計画レビューのセッションが上限（$MAX_PLAN_REVIEWS本）に達しているため起動しませんでした（現在 $live_reviews 本）。"
      return 0
    fi
    launch_and_report "$job_id" "$(plan_review_session_name "$repo" "$issue_number")" \
      "計画レビュー（G1）を起動しています" \
      bash "$PLAN_REVIEW_LAUNCHER" "$owner" "$repo" "$issue_number"
    return 0
  fi

  # リポジトリ全体のコードレビュー（#698）。**`local_repo_check`は通さない**（版数の契約は
  # 実装セッション用で、こちらは読むだけ）。cloneが無い場合はランチャー側が理由を出して落ちる。
  #
  # **重複起動の判定に使うセッション名は`<repo>-code-review-<番号>`**（計画レビューと同じ理由で
  # `-issue-`の規約から外してある）。
  if [[ "$kind" == "CODE_REVIEW" ]]; then
    if [[ ! -f "$CODE_REVIEW_LAUNCHER" ]]; then
      report_job "$job_id" failed "コードレビューのランチャーがありません（$CODE_REVIEW_LAUNCHER）。"
      return 0
    fi
    # **本数の上限はここでしか見られない**（計画レビューと同じ。セッションは`count_issue_sessions`に
    # 数えられず、ジョブも起動した時点で閉じる）。**失敗ではなく見送り**として報告する——
    # ガードが正常に働いた結果で、何も壊れていない。見送ったレビューは画面から起こし直せる
    local live_code_reviews
    live_code_reviews="$(count_code_review_sessions)"
    if [[ "$MAX_CODE_REVIEWS" -gt 0 && "${live_code_reviews:-0}" -ge "$MAX_CODE_REVIEWS" ]]; then
      report_job "$job_id" skipped \
        "コードレビューのセッションが上限（$MAX_CODE_REVIEWS本）に達しているため起動しませんでした（現在 $live_code_reviews 本）。"
      return 0
    fi
    launch_and_report "$job_id" "$(code_review_session_name "$repo" "$issue_number")" \
      "コードレビューを起動しています" \
      bash "$CODE_REVIEW_LAUNCHER" "$owner" "$repo" "$issue_number"
    return 0
  fi

  # 手作業の代行実行（#1828）。**セッションを立てず、tmuxにも触らない。** cloneの有無も
  # 問わない（実行するのはホスト上のコマンドで、worktreeを作るわけではない）。
  if [[ "$kind" == "MANUAL_STEP" ]]; then
    run_manual_step_job "$job_id" "$owner" "$repo" "$issue_number" "$command"
    return 0
  fi

  # 走っている代行実行の中断（#1882）。**受け取るのは止める対象のジョブidだけ**で、
  # 実行するコマンドは受け取らない（ユニット名はこちらで組み立て直す。`INTERRUPT`・`KILL`が
  # セッション名を組み立て直すのと同じ作法で、任意の`systemctl stop`を流す口にしない）。
  if [[ "$kind" == "MANUAL_STEP_ABORT" ]]; then
    abort_manual_step_job "$job_id" "$(printf '%s' "$job_json" | jq -r '.targetJobId // ""')"
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

  launch_and_report "$job_id" "$(expected_session_name "$repo" "$issue_number")" \
    "起動しています（$LOCAL_REPO_PATH）" \
    bash "$LAUNCHER" "$owner" "$repo" "$issue_number"
}

# 重複起動を確かめてからランチャーを走らせ、tmuxセッションの増分で成否を報告する。
#
# **セッションを立てる4種別（`LAUNCH`・`CROSS_REPO_QUESTION`・`PLAN_REVIEW`・`CODE_REVIEW`）で
# 共有する。**
# 違うのは走らせるコマンドと期待するセッション名だけで、重複防止・`running`の報告・差分による
# 成否判定・失敗時の出力の返し方はまったく同じ。分けて持つと、片方だけ直したときに挙動がずれる。
#
# **期待するセッション名を引数で受ける**（#1855）。以前はリポジトリ名とIssue番号から
# `<repo>-issue-<番号>`を組み立てていたが、計画レビューは**実装セッションが動いている最中に
# 起こすもの**で、その名前で重複を見ると必ず「起動済みのため見送り」になる。
#
#   $1 ジョブID / $2 期待するtmuxセッション名 / $3 `running`として画面へ出す文言
#   $4以降 実行するコマンド
launch_and_report() {
  local job_id="$1" expected_session="$2" running_message="$3"
  shift 3

  # 重複起動の防止（#1179）。同じIssueのtmuxセッションが既にあるなら起動しない。
  # issue-deck側のactiveKeyとは別の層で、**手元のターミナルから直接起動した分**まで拾える
  # （そちらはissue-deckにジョブとして残らないため、DB側の制約では防げない）。
  #
  # **リポジトリ名まで含めて突き合わせる**（#1224）。Issue番号はリポジトリごとに振られるため、
  # 番号だけ（`*-issue-<番号>`）で見ると、別リポジトリの同じ番号のセッションが動いているだけで
  # 起動を断ってしまう。起動できるリポジトリが1つだった間は表に出なかったが、増やした時点で
  # 番号の衝突はほぼ確実に起きる。セッション名の規約は`<リポジトリ名>-issue-<番号>`
  # （docs/multi-agent/local-quick-start.md「セッション名」）。
  local before after new_sessions
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

  # **ランチャーを走らせる前に、tmuxサーバーを別のcgroupへ出しておく**（#1935）。ここを通らないと
  # サーバーを起こすのはランチャーの`tmux new-session`になり、pollerと同じcgroupに入る。
  # 直前の`reap_sessions`で最後のセッションが畳まれてサーバーが落ちていることもあるため、
  # 起動時に1度だけでは足りず、起動のたびに確かめる（動いていれば何もしない）。
  ensure_tmux_server_scope

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
    report_job "$job_id" succeeded "tmuxセッション $session を起動しました" "$session"
  else
    # 起動の出力をそのまま返す。受け口は「何を直せばよいか」まで書いて止まるため、
    # 画面にそのまま出せば原因が分かる。
    local message
    message="$(tail -c 1500 "$output_file")"
    # 出力は`report_job`が報告と同じ文字列で標準エラーへ出す（#1228）。
    report_job "$job_id" failed "起動できませんでした（終了コード $launch_status）: $message"
  fi
  rm -f "$output_file"
}

# --- 1巡 ----------------------------------------------------------------------
# 申告 → claim → 起動。**1巡の失敗でプロセスを終わらせない**（常駐時は次の巡で復帰できる）。
run_once() {
  announce || return 1

  # 終わった実装セッションの開発サーバーを回収する（#1223）。
  # **claimより先に行う。** サブPCは並行3本が上限（#1177・載せ替え後の実測は#1812）で、
  # 掴んだままの開発サーバーがあると新しいジョブを取っても起こせない。取りに行く前に空けておく。
  reap_dev_servers

  # 作業が終わったセッションそのものを畳む（#1256）。**開発サーバーの回収の後に行う。**
  # 畳めば`run-issue-session.sh`のtrapが開発サーバーも止めるが、trapを通れなかったぶんは
  # 次の巡で孤児として回収される。
  reap_sessions

  # マージ済みworktreeを掃除する（#1716）。**セッションの回収の後に行う。** 直前に畳んだ
  # セッションのworktreeを、同じ巡でそのまま消せる（セッションが動いている間は消えない）。
  # 毎巡ではなく WORKTREE_CLEANUP_INTERVAL_MINUTES の間隔でだけ実際に走る。
  reap_worktrees

  # 掃除で消えなかったworktreeの`node_modules`をハードリンクへまとめる（#2124）。
  # **掃除の後に行う。** 消えるworktreeを走査しても無駄になる。既定は1日1回で、
  # 走査自体は別プロセスへ出すのでこの巡は待たない。
  reap_node_modules_duplicates

  # 起動済みセッションの状態を報告する（#1217）。**claimより先に行う**。
  # ここで失敗しても続けるが、先に出しておくと「取りに行く前の状態」が残り、
  # 起動が失敗したときの前後関係が読める。
  report_sessions

  if [[ "$ANNOUNCE_ONLY" -eq 1 ]]; then
    return 0
  fi

  # コンフリクトしたPRの巡回検知をissue-deckへ促す（#2116）。**dry-runでは呼ばない**
  # （ワークフローの起動という外向きの副作用があるため）。
  if [[ "$DRY_RUN" -eq 0 ]]; then
    sweep_pull_request_conflicts
    # 本番デプロイ失敗の巡回検知（#2236）。**dry-runでは呼ばない**（Issueの起票という
    # 外向きの副作用があるため）。
    sweep_deploy_failures
  fi

  # APIエラー（529等）で中断したセッションを再開する（#1971）。**回収と報告の後に行う。**
  # 畳まれたセッションへ送りに行かず、報告には再開前の状態が残る（前後関係が読める）。
  resume_interrupted_sessions

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
  #
  # **本数に空きがあっても、メモリ・SWAPが逼迫していれば同じく見送る**（#2095）。上限が見ている
  # のは本数だけで、実際の空きメモリではない。重い作業が重なっているところへ足すと、12本に
  # 届く前にホストごと止まる（2026-08-14に実際に起きている）。判定に使うのは`announce`が
  # この巡の入口で集めた使用率で、**画面に出ている数字と同じもの**。
  local live_sessions claim_max_jobs
  live_sessions="$(count_issue_sessions)"
  claim_max_jobs="$MAX_JOBS"
  if [[ "$live_sessions" -ge "$MAX_SESSIONS" ]]; then
    echo "セッションが上限に達しているため、起動ジョブは取りに行きません（$live_sessions/$MAX_SESSIONS 本）。"
    claim_max_jobs=0
  elif [[ -n "$LAUNCH_HOLD_MESSAGE" ]]; then
    echo "$LAUNCH_HOLD_MESSAGE"
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

# tmuxサーバーを別のcgroupで起こしておく（#1935）。起動のたびにも確かめる（launch_and_report）が、
# ここで先に置いておくと、手元のターミナルから直接`start-issue.sh`を叩いたセッションも同じ
# サーバーにぶら下がり、pollerの再起動と無関係でいられる。
# **申告だけ・dry-runでは起こさない**（何も起動しないと言っている経路で状態を作らない）。
if [[ "$ANNOUNCE_ONLY" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
  ensure_tmux_server_scope
fi

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
