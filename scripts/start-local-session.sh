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

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

OWNER="$1"
REPO="$2"
ISSUE_NUMBER="$3"

# src/lib/local-session.ts の OWNER_OR_REPO_PATTERN と同じ文字集合に揃える。
# 片側だけを緩めると、緩めた側が単独で穴になる。
if [[ ! "$OWNER" =~ ^[A-Za-z0-9._-]+$ || ! "$REPO" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Error: owner・repoに使えない文字が含まれています: $OWNER/$REPO" >&2
  exit 1
fi
# `.`を許可しているため `.` `..` 自体が通る。パスの一部として使うので明示的に弾く。
if [[ "$OWNER" =~ ^\.+$ || "$REPO" =~ ^\.+$ ]]; then
  echo "Error: owner・repoにディレクトリ参照は指定できません: $OWNER/$REPO" >&2
  exit 1
fi
if [[ ! "$ISSUE_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: issue番号は正の整数で指定してください: $ISSUE_NUMBER" >&2
  exit 1
fi

FULL_NAME="$OWNER/$REPO"

# リポジトリ→ローカルのチェックアウト先の対応表。
# 既定はissue-deck自身のみ。他リポジトリを足す場合は設定ファイルに1行ずつ書く
# （`owner/repo<空白>絶対パス`。`#`始まりはコメント）。パスに空白を含んでもよい
# （最初の空白までをリポジトリ名、残りをパスとして扱う）。
CONFIG_FILE="${ISSUE_DECK_LOCAL_REPOS_CONFIG:-$HOME/.config/issue-deck/local-repos.conf}"

resolve_repo_path() {
  local target="$1"
  if [[ -f "$CONFIG_FILE" ]]; then
    local line name path
    # `read -r name path _` だとパスが空白で切れるため、1行読んで最初の空白で2分割する。
    # 併せてCRLFの改行と行末の空白も落とす（Windows側のエディタで編集されうるため）。
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
      [[ "$line" =~ ^[[:space:]]*([^[:space:]]+)[[:space:]]+(.+)$ ]] || continue
      name="${BASH_REMATCH[1]}"
      path="${BASH_REMATCH[2]}"
      path="${path%"${path##*[![:space:]]}"}"
      if [[ "$name" == "$target" ]]; then
        # 設定ファイル側の `~` はシェル展開されないため自前で展開する。
        printf '%s\n' "${path/#\~/$HOME}"
        return 0
      fi
    done <"$CONFIG_FILE"
  fi
  if [[ "$target" == "guchi-apps/issue-deck" ]]; then
    printf '%s\n' "$HOME/apps/issue-deck"
    return 0
  fi
  return 1
}

if ! REPO_PATH="$(resolve_repo_path "$FULL_NAME")"; then
  echo "Error: $FULL_NAME のローカルチェックアウト先が分かりません。" >&2
  echo "  $CONFIG_FILE に次の形式で追記してください:" >&2
  echo "    $FULL_NAME /home/$(whoami)/apps/$REPO" >&2
  exit 1
fi

if [[ ! -d "$REPO_PATH" ]]; then
  echo "Error: $FULL_NAME のチェックアウト先が存在しません: $REPO_PATH" >&2
  exit 1
fi

LAUNCHER="$REPO_PATH/scripts/start-issue.sh"
if [[ ! -x "$LAUNCHER" && ! -f "$LAUNCHER" ]]; then
  echo "Error: $FULL_NAME には scripts/start-issue.sh がありません（$LAUNCHER）。" >&2
  echo "  ワンクリック起動に対応しているのは、このスクリプトを持つリポジトリだけです。" >&2
  exit 1
fi

# ローカル起動プロトコルの版数を確かめる（#1073）。ファイルがあっても約束を守っているとは
# 限らず、守っていないと起動してから無言で固まる（ISSUE_DECK_SKIP_LAN_SETUPを解釈しない
# リポジトリでは、UACを承認しても待ちから戻らない）。押した先で固まるより、ここで止める。
# 版数は src/lib/local-session.ts の LOCAL_SESSION_CONTRACT_VERSION と揃える。
SUPPORTED_CONTRACT_VERSION=2
DECLARED_VERSION="$(grep -oP '^#\s*issue-deck-local-session:\s*v\K[0-9]+' "$LAUNCHER" | head -1 || true)"
if [[ -z "$DECLARED_VERSION" ]]; then
  echo "Error: $FULL_NAME はローカル起動プロトコルに対応していません。" >&2
  echo "  $LAUNCHER の冒頭に次の1行を足し、約束を満たすようにしてください:" >&2
  echo "    # issue-deck-local-session: v$SUPPORTED_CONTRACT_VERSION" >&2
  echo "  約束の内容は issue-deck の docs/multi-agent/local-quick-start.md を参照してください。" >&2
  exit 1
fi
if [[ "$DECLARED_VERSION" -gt "$SUPPORTED_CONTRACT_VERSION" ]]; then
  echo "Error: $FULL_NAME が宣言する v$DECLARED_VERSION は、この受け口が扱える v$SUPPORTED_CONTRACT_VERSION より新しいです。" >&2
  echo "  issue-deck側を更新してから、register-issuedeck-protocol.ps1 を再実行してください。" >&2
  exit 1
fi

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
