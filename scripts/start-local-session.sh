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

echo "#$ISSUE_NUMBER: $FULL_NAME（$REPO_PATH）のセッションを起動します..."
cd "$REPO_PATH"

# wt.exeから開いたタブは `bash -lc`（非対話シェル）で始まる。Ubuntuの ~/.bashrc は冒頭で
# 非対話シェルを弾くため、そこで設定しているnvmが読まれず、node・pnpmがPATHに乗らない
# （システムのnodeだけが見える）。対象リポジトリのstart-issue.shはpnpmを使うので、
# 見つからない場合はここで明示的に読み込む（#1085）。
if ! command -v pnpm >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # nvm.sh は set -u 下で未定義変数を参照し、set -e とも相性が悪いため一時的に外す。
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    set -eu
    if command -v pnpm >/dev/null 2>&1; then
      echo "#$ISSUE_NUMBER: nvmを読み込みました（node $(node --version) / pnpm $(pnpm --version)）"
    else
      echo "#$ISSUE_NUMBER: 警告: nvmを読み込みましたがpnpmが見つかりません。" >&2
    fi
  else
    echo "#$ISSUE_NUMBER: 警告: pnpmもnvm（$NVM_DIR/nvm.sh）も見つかりません。" >&2
  fi
fi

# LANアクセス設定（Windowsの管理者権限が必要）は、wt.exeで開いたタブではUACを承認しても
# 待ちから戻らずタブが固まる。ワンクリック起動では行わない（#1076）。
# コマンドライン引数ではなく環境変数で渡すのは、この指定を解釈しないリポジトリの
# start-issue.shへ渡っても無害にするため（未知のフラグはissue番号として扱われて失敗する）。
export ISSUE_DECK_SKIP_LAN_SETUP=1
# start-issue.shはworktree作成〜devサーバー起動〜claude起動まで自前で面倒を見る。
# execで置き換えるため、以降のtrapはstart-issue.sh側の挙動に委ねる。
trap - EXIT
exec bash "$LAUNCHER" "$ISSUE_NUMBER"
