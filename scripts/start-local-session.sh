#!/usr/bin/env bash
# 画面の「ローカルで開始」から起動される受け口（#1049）。
#
# 使い方:
#   scripts/start-local-session.sh <owner> <repo> <issue番号>
#
# 呼び出し経路:
#   issue-deckの画面
#     → issuedeck://start/<owner>/<repo>/<番号>
#     → scripts/windows/issuedeck-protocol.cmd（Windows側のプロトコルハンドラ）
#     → wt.exe → wsl.exe → このスクリプト
#     → 対象リポジトリの scripts/start-issue.sh
#
# 引数はブラウザ経由で外部から渡りうるため、ハンドラ側で検証済みでも改めて検証する
# （多層防御。片側の検証が緩んでもここで止まる）。
#
# リポジトリの解決・検証は lib/local-repo-resolve.sh が持つ。サブPCのディスパッチpoller
# （scripts/subpc-dispatch-poller.sh）が「自分が実行できるリポジトリ」を申告する際に
# **同じ判定を使う**ためで、判定を二重に持つと申告と実際の起動可否がずれる（#1179）。

set -euo pipefail

# 新しいターミナルタブで起動されるため、エラーで即座にタブが閉じると原因が読めない。
# 異常終了時だけ入力待ちで止める。
pause_on_error() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo >&2
    read -r -p "エラーで終了しました。Enterで閉じます..." _ || true
  fi
}
trap pause_on_error EXIT

usage() {
  echo "Usage: scripts/start-local-session.sh <owner> <repo> <issue番号>" >&2
}

# 判定を共有するライブラリ。**リポジトリ内でも複製先でも同じ相対位置**に置く。
# 複製先（~/.local/share/issue-deck/）へは register-issuedeck-protocol.ps1 が
# このスクリプトと一緒に lib/ ごと配る。古い複製には lib/ が無いため、
# 「何が起きているのか分からない失敗」にせず、再登録を案内して止める。
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
if [[ ! -f "$LIB_DIR/local-repo-resolve.sh" ]]; then
  echo "Error: $LIB_DIR/local-repo-resolve.sh がありません。" >&2
  echo "  受け口の複製が古い可能性があります。issue-deckのリポジトリで次を実行し、" >&2
  echo "  プロトコル登録をやり直してください:" >&2
  echo "    powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"\$(wslpath -w ~/apps/issue-deck/scripts/windows/register-issuedeck-protocol.ps1)\"" >&2
  exit 1
fi
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$LIB_DIR/local-repo-resolve.sh"

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

OWNER="$1"
REPO="$2"
ISSUE_NUMBER="$3"

local_session_validate_target "$OWNER" "$REPO" "$ISSUE_NUMBER" || exit 1

FULL_NAME="$OWNER/$REPO"

# 対応表の解決からプロトコル版数の確認まで（4段階）をまとめて行う。
# 黙って失敗させず、何を直せばよいかまで出して止める。
if ! local_repo_check "$FULL_NAME"; then
  local_repo_print_error "$FULL_NAME"
  exit 1
fi
REPO_PATH="$LOCAL_REPO_PATH"
LAUNCHER="$LOCAL_REPO_LAUNCHER"

echo "#$ISSUE_NUMBER: $FULL_NAME（$REPO_PATH）のセッションを起動します..."
cd "$REPO_PATH"

# 対象リポジトリが必要とするパッケージマネージャを判定する。リポジトリごとに違うため
# （issue-deck・dayspanはpnpm、shopping-listはnpmで依存インストールもしない）、pnpmを
# 無条件に必須化すると壊れる。判定は宣言 → ロックファイル → package.json の順で確からしい
# ものを採る。Node系でないリポジトリでは何も要求しない。
detect_package_manager() {
  local dir="$1"
  if [[ -f "$dir/package.json" ]]; then
    local declared
    declared="$(grep -oP '"packageManager"\s*:\s*"\K[a-z]+' "$dir/package.json" | head -1 || true)"
    if [[ -n "$declared" ]]; then
      printf '%s\n' "$declared"
      return 0
    fi
  fi
  if [[ -f "$dir/pnpm-lock.yaml" ]]; then printf 'pnpm\n'; return 0; fi
  if [[ -f "$dir/yarn.lock" ]]; then printf 'yarn\n'; return 0; fi
  if [[ -f "$dir/bun.lockb" || -f "$dir/bun.lock" ]]; then printf 'bun\n'; return 0; fi
  if [[ -f "$dir/package-lock.json" || -f "$dir/package.json" ]]; then printf 'npm\n'; return 0; fi
  printf '\n'
}

PACKAGE_MANAGER="$(detect_package_manager "$REPO_PATH")"

# wt.exeから開いたタブは `bash -lc`（非対話シェル）で始まる。Ubuntuの ~/.bashrc は冒頭で
# 非対話シェルを弾くため、そこで設定しているnvmが読まれず、node系のコマンドがPATHに乗らない
# （システムのnodeだけが見える。#1085）。Node系のリポジトリなら読み込む。
# 「pnpmが無いとき」ではなく「Node系なら」を条件にしているのは、npmのリポジトリでも
# 通常ターミナルと同じnodeで動かすため（システムのnodeはバージョンが古いことがある）。
if [[ -f "$REPO_PATH/package.json" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # nvm.sh は set -u 下で未定義変数を参照し、set -e とも相性が悪いため一時的に外す。
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    set -eu
    if command -v node >/dev/null 2>&1; then
      echo "#$ISSUE_NUMBER: nvmを読み込みました（node $(node --version)）"
    fi
  fi
fi

# 判定したパッケージマネージャが無ければ、worktreeを作る前にここで止める。
# start-issue.sh の途中で落ちると中途半端なworktreeとブランチが残るため。
if [[ -n "$PACKAGE_MANAGER" ]] && ! command -v "$PACKAGE_MANAGER" >/dev/null 2>&1; then
  echo "Error: $FULL_NAME が必要とする $PACKAGE_MANAGER が見つかりません。" >&2
  echo "  nvmを使っている場合、非対話シェルでは ~/.bashrc が読まれないため、" >&2
  echo "  ~/.profile 等で nvm を読み込むか、$PACKAGE_MANAGER をPATHの通る場所へ入れてください。" >&2
  exit 1
fi

# 起動に必要な外部コマンド。3リポジトリのstart-issue.shに同じ確認が重複していたため、
# 経路の共通部分であるここへ寄せた（各リポジトリ側はターミナル直叩き用に残っている）。
for required_command in git gh claude; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done

# LANアクセス設定（Windowsの管理者権限が必要）は、wt.exeで開いたタブではUACを承認しても
# 待ちから戻らずタブが固まる。ワンクリック起動では行わない（#1076）。
# コマンドライン引数ではなく環境変数で渡すのは、この指定を解釈しないリポジトリの
# start-issue.shへ渡っても無害にするため（未知のフラグはissue番号として扱われて失敗する）。
export ISSUE_DECK_SKIP_LAN_SETUP=1

# 開発サーバーのポートは「ベース値 + Issue番号」で採番される。どのリポジトリがどの帯を使うかは
# 定義上どのリポジトリ単独でも決められないため、全リポジトリを知る唯一の場所であるここが持つ
# （#1073）。実際、issue-deckとshopping-listが同じ4000帯のまま衝突していた。
# 表に無いリポジトリへは渡さず、そのリポジトリの既定に任せる。
#
# **各リポジトリのstart-issue.sh側の既定値も、この表と同じ値に揃える**（#1178）。ターミナル
# 直叩き・tmux経路はここを通らずベース値が渡らないため、既定値がずれていると同じIssueでも
# 起動経路によってポートが変わり、1台に複数リポジトリのセッションが常駐するマシン
# （サブPC）では他リポジトリの帯と衝突する。
case "$FULL_NAME" in
  guchi-apps/issue-deck) export ISSUE_DECK_DEV_PORT_BASE=4000 ;;
  guchi-apps/shopping-list) export ISSUE_DECK_DEV_PORT_BASE=5000 ;;
  guchi-apps/dayspan) export ISSUE_DECK_DEV_PORT_BASE=6000 ;;
esac

# start-issue.shはworktree作成〜devサーバー起動〜claude起動まで自前で面倒を見る。
# execで置き換えるため、以降のtrapはstart-issue.sh側の挙動に委ねる。
trap - EXIT
exec bash "$LAUNCHER" "$ISSUE_NUMBER"
