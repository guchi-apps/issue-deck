#!/usr/bin/env bash
# Issue #258: 無人実行(CI)で開発サーバーを起動し、Playwrightでスクリーンショットを
# 撮影したうえで、scripts/post-issue-screenshot.sh（#255）を呼び出してscreenshots
# ブランチへ配置し、Issueコメント埋め込み用のraw URLを標準出力に1行1URLで出力する。
#
# 使い方:
#   scripts/capture-issue-screenshots.sh <Issue番号> [撮影対象パス] [クリック対象セレクタ] [デバイス]
#
# Issue #858: 第4引数（デバイス）を指定すると、撮影対象パス指定時のデスクトップ・モバイル
# 各1枚ずつという既定の組を、"desktop"または"mobile"のみに絞れる。アカウントメニューの
# ようにPC版にしか無いUIをクリックで開いて撮影したい場合、モバイル版には対象要素が存在せず
# クリックが失敗して全体が失敗してしまうため。省略時は従来どおり両方（"both"）を撮影する。
# 撮影対象パスを省略するフォールバック撮影では対応しない（第2引数省略時は無視される）。
#
# Issue #567: 第2引数（撮影対象パス）を指定した場合はそのパスをデスクトップ・モバイル
# 各1枚ずつ撮影する（従来と同じ、出力URLは2行）。省略した場合は、実装エージェントが
# 対応箇所を判断できなかった場合のフォールバックとして、デスクトップは/dashboard1枚、
# モバイルはホーム・イシュー一覧・イシュー詳細の計3枚を撮影する（出力URLは4行）。
# イシュー詳細の撮影にはフロントエンドのIssue.id（githubIssueId由来）が必要なため、
# scripts/ci-get-sample-issue-id.mjsでCI用ダミーデータ（scripts/seed-ci-db.mjs）の
# githubIssueIdを取得する。
#
# Issue #756: 第3引数（クリック対象セレクタ）を指定すると、ダイアログ等クリック操作でしか
# 到達できない画面状態を撮影できる。Playwright互換のセレクタ（`text=`・`role=`・CSS等）を
# 指定でき、撮影対象パスへ遷移した後にそのセレクタをクリックしてから撮影する。第2引数
# （撮影対象パス）を省略した場合のフォールバック撮影では対応しない（対象パスが不明な時点で
# クリック対象も指定しようがないため）。
#
# 前提:
#   - pnpm install済み、Playwrightのブラウザ本体(chromium)がインストール済みであること
#     (`pnpm exec playwright install --with-deps chromium`)
#   - DBマイグレーション・ダミーデータのシード（scripts/ci-seed-user.mjs含む）が
#     完了していること(#256, #257)
#   - `gh`コマンドで認証済み、`screenshots`ブランチへpushできる権限があること
#     (scripts/post-issue-screenshot.shと同じ前提)
#
# ヘルスチェック・撮影対象パスの既定値は/dashboard。"/"はCIバイパスCookie使用時、
# src/lib/supabase/middleware.tsの挙動によりログイン画面へ遷移してしまうため
# ダッシュボードを直接指定している。
#
# Issue #308: 起動待ちのヘルスチェックcurlがCIバイパスCookie無しでリクエストしていたため、
# src/lib/supabase/middleware.tsがバイパス判定前にSupabaseクライアントを生成しようとし、
# 実際のSupabaseプロジェクト（NEXT_PUBLIC_SUPABASE_URL等）が未設定の環境では
# 「Your project's URL and Key are required to create a Supabase client!」で落ちていた(#299)。
# ヘルスチェックにもPlaywright撮影と同じCIバイパスCookieを付与し、Supabase自体を
# 経由しないようにする。NEXT_PUBLIC_SUPABASE_URL等のプレースホルダーは、CIバイパス対象外の
# パスに迷い込んだ場合の保険として.github/workflows/ci.ymlと同じ値を設定しておく。

set -euo pipefail

# `pnpm run capture:issue-screenshots -- <Issue番号>`という呼び出し規約(#522)で使う`--`は、
# npmと異なりpnpmではオプション区切りとして消費されず、そのままスクリプトへの第1引数として
# 転送される(pnpm 10.34.5で実測・確認)。放置すると`$1`が`--`になり、直後の数字チェックで
# 常に失敗する(#673)。`--`が単独で渡された場合のみ読み飛ばし、後続の引数をそのまま使う。
if [[ "${1:-}" == "--" ]]; then
  shift
fi

ISSUE_NUMBER="${1:?Issue番号を指定してください}"
TARGET_PATH="${2:-}"
CLICK_SELECTOR="${3:-}"
DEVICE="${4:-both}"
HEALTHCHECK_PATH="${TARGET_PATH:-/dashboard}"

if [[ "$DEVICE" != "both" && "$DEVICE" != "desktop" && "$DEVICE" != "mobile" ]]; then
  echo "Error: デバイスは both・desktop・mobile のいずれかで指定してください: $DEVICE" >&2
  exit 1
fi

if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: issue番号は数字で指定してください: $ISSUE_NUMBER" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3100}"
BASE_URL="http://127.0.0.1:${PORT}"
export DATABASE_URL="${DATABASE_URL:-mysql://placeholder:placeholder@127.0.0.1:3306/app_issue_deck}"
export CI_LOGIN_BYPASS_SECRET="${CI_LOGIN_BYPASS_SECRET:-ci-screenshot-bypass-secret}"
export NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-https://ci-placeholder.supabase.co}"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:-ci-placeholder}"
# src/lib/github/app-auth.tsがモジュール読み込み時点でGITHUB_APP_ID・
# GITHUB_APP_PRIVATE_KEY_BASE64を要求するため、未設定だと`/api/issues/comments`等
# GitHub呼び出し系のAPI Routeが（実際には呼ばれないコードパスであっても）import時点で
# 例外を投げ500になってしまう（#572）。CIバイパス経由のダミーコメント応答
# （src/app/api/issues/comments/route.ts）はこれらの値を実際には使わないため、
# モジュール読み込みを通すためだけのプレースホルダーでよい。
export GITHUB_APP_ID="${GITHUB_APP_ID:-000000}"
export GITHUB_APP_PRIVATE_KEY_BASE64="${GITHUB_APP_PRIVATE_KEY_BASE64:-Y2ktc2NyZWVuc2hvdC1wbGFjZWhvbGRlci1rZXk=}"

# src/lib/ci-auth-bypass.tsのCI_BYPASS_COOKIE_NAMEと必ず一致させること
# （scripts/capture-screenshots.mjsと同じ理由で、シェルスクリプトからTSの値を
# 直接importできないため直書きしている）。
CI_BYPASS_COOKIE_NAME="ci-login-bypass"

OUT_DIR="$(mktemp -d)"
LOG_FILE="$(mktemp)"

cleanup() {
  if [[ -n "${DEV_PID:-}" ]]; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

cd "$ROOT"
pnpm exec next dev -p "$PORT" >"$LOG_FILE" 2>&1 &
DEV_PID=$!

echo "開発サーバーの起動を待機します（${BASE_URL}${HEALTHCHECK_PATH}）..." >&2
READY=false
for _ in $(seq 1 60); do
  if curl --silent --fail --output /dev/null --cookie "${CI_BYPASS_COOKIE_NAME}=${CI_LOGIN_BYPASS_SECRET}" "${BASE_URL}${HEALTHCHECK_PATH}"; then
    READY=true
    break
  fi
  sleep 1
done

if [[ "$READY" != "true" ]]; then
  echo "Error: 開発サーバーが起動しませんでした。ログ:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if [[ -n "$TARGET_PATH" ]]; then
  # 対応箇所が分かる場合: 指定パスをデスクトップ・モバイル各1枚ずつ撮影する（従来と同じ構成）。
  # クリック対象セレクタが指定されていれば、撮影対象の指定にそのまま付加する
  # （scripts/capture-screenshots.mjs側の<名前:パス:device:セレクタ>形式）。
  # デバイス指定（第4引数）が"desktop"/"mobile"の場合はその1枚のみ撮影する。
  DESKTOP_TARGET="desktop:${TARGET_PATH}:desktop"
  MOBILE_TARGET="mobile:${TARGET_PATH}:mobile"
  if [[ -n "$CLICK_SELECTOR" ]]; then
    DESKTOP_TARGET="${DESKTOP_TARGET}:${CLICK_SELECTOR}"
    MOBILE_TARGET="${MOBILE_TARGET}:${CLICK_SELECTOR}"
  fi

  TARGETS=()
  IMAGES=()
  if [[ "$DEVICE" != "mobile" ]]; then
    TARGETS+=("$DESKTOP_TARGET")
    IMAGES+=("$OUT_DIR/desktop.png")
  fi
  if [[ "$DEVICE" != "desktop" ]]; then
    TARGETS+=("$MOBILE_TARGET")
    IMAGES+=("$OUT_DIR/mobile.png")
  fi

  node "$ROOT/scripts/capture-screenshots.mjs" "$BASE_URL" "$OUT_DIR" "${TARGETS[@]}"

  bash "$ROOT/scripts/post-issue-screenshot.sh" "$ISSUE_NUMBER" "${IMAGES[@]}"
else
  # 対応箇所の判断が難しい場合のフォールバック: デスクトップは/dashboard1枚、
  # モバイルはホーム・イシュー一覧・イシュー詳細の計3枚を撮影する。
  echo "撮影対象パスの指定が無いため、フォールバック撮影モード（PC1枚+スマホ3枚）で撮影します。" >&2

  SAMPLE_ISSUE_ID="$(node "$ROOT/scripts/ci-get-sample-issue-id.mjs")"

  node "$ROOT/scripts/capture-screenshots.mjs" "$BASE_URL" "$OUT_DIR" \
    "desktop:/dashboard:desktop" \
    "mobile-home:/dashboard:mobile" \
    "mobile-issues:/dashboard?mscreen=issues:mobile" \
    "mobile-issue-detail:/dashboard?mscreen=issue-detail&missue=${SAMPLE_ISSUE_ID}:mobile"

  bash "$ROOT/scripts/post-issue-screenshot.sh" "$ISSUE_NUMBER" \
    "$OUT_DIR/desktop.png" "$OUT_DIR/mobile-home.png" "$OUT_DIR/mobile-issues.png" "$OUT_DIR/mobile-issue-detail.png"
fi
