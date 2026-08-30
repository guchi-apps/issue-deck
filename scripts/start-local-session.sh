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
#     → 対象リポジトリの scripts/start-issue.sh または汎用ランチャー
#
#   issue-deckの画面（サブPCで開始）
#     → ジョブキュー → scripts/subpc-dispatch-poller.sh → このスクリプト
#
# 出口は2つある（#1224）。判定は lib/local-repo-resolve.sh が持つ。
#
#   contract  対象リポジトリが契約適合の scripts/start-issue.sh を持つ → それを exec する
#   generic   持たない                                                → 汎用ランチャーを exec する
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
LAUNCH_MODE="$LOCAL_REPO_MODE"

echo "#$ISSUE_NUMBER: $FULL_NAME（$REPO_PATH）のセッションを起動します..."
cd "$REPO_PATH"

# 判定は lib/local-repo-resolve.sh と共有する（汎用ランチャーも同じ関数を使う）。
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

# 起こすエージェントCLI（#2377・#2505）。**画面から選ばれた場合はpollerが`ISSUE_DECK_AGENT`で
# 渡してくる**（`scripts/subpc-dispatch-poller.sh`）。指定が無ければ従来どおりClaude Code。
#
# ここで解決した種別は、下の存在チェックと、その先の start-issue.sh（`--agent`と同じ入口）で使う。
AGENT_KIND="${ISSUE_DECK_AGENT:-claude}"
case "$AGENT_KIND" in
  claude) AGENT_COMMAND="claude" ;;
  codex) AGENT_COMMAND="codex" ;;
  *)
    echo "Error: 対応していないエージェントです: $AGENT_KIND（指定できるのは claude codex）" >&2
    exit 1
    ;;
esac
export ISSUE_DECK_AGENT="$AGENT_KIND"

# 起動に必要な外部コマンド。3リポジトリのstart-issue.shに同じ確認が重複していたため、
# 経路の共通部分であるここへ寄せた（各リポジトリ側はターミナル直叩き用に残っている）。
#
# **エージェントのCLIは選ばれたものを見る**（#2505）。`claude`固定のままだと、Codexで起こす
# ときに使いもしないCLIの有無で止まる。
for required_command in git gh "$AGENT_COMMAND"; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done

# 既定以外のエージェントで起こせる出口かを、worktreeを作る前に確かめる（#2505）。
#
# **黙ってClaude Codeで立てない。** 画面には選んだエージェントの名前が出ているので、
# 別のCLIが立つと「Codexを選んだのに通知が飛ばない仕組みが動いている」という読み方になる。
# ここで`exit 1`すればpollerがジョブを`failed`にし、この文面が画面に出る。
#
# **確かめるのは契約適合（`contract`）の出口だけ**（#2590）。汎用ランチャー
# （`scripts/generic-start-issue.sh`）はissue-deck自身のスクリプトで、`ISSUE_DECK_AGENT`を
# 読んでエージェントを選ぶようになっている。対象リポジトリ側には何も要らない。
#
# **契約適合のリポジトリは、実際に走るファイルを見て判定する**（宣言された版数ではなく）。
# ローカル起動プロトコルの版数はリポジトリ側が手で書くもので、`ISSUE_DECK_AGENT`を読むように
# したかどうかとは連動しない。走るファイルそのものを見れば、版数の宣言が古いままでも正しく判定できる。
if [[ "$AGENT_KIND" != "claude" && "$LAUNCH_MODE" != "generic" ]]; then
  if ! grep -q 'ISSUE_DECK_AGENT' "$LAUNCHER"; then
    echo "Error: $FULL_NAME の scripts/start-issue.sh は ISSUE_DECK_AGENT を読みません。" >&2
    echo "  このまま起動すると $AGENT_KIND を選んでも Claude Code が立つため、ここで止めます。" >&2
    echo "  対象リポジトリの start-issue.sh を issue-deck と同じ形（scripts/lib/agent-cli.sh）へ" >&2
    echo "  揃えてください（docs/multi-agent/codex.md）。" >&2
    exit 1
  fi
fi

# フォルダの信頼確認が済んでいるか（#1838）。**worktreeを作る前にここで止める。**
#
# 初めてClaude Codeを開くリポジトリでは、`claude`の起動直後に信頼確認が出て、答えるまで
# セッションが始まらない。この間はフックが1つも飛ばない（#1465）ので、画面には「実行中」と
# 出たまま何も進まず、3分後に「まだ開始していません」が出て`00.check-user`が付く。しかも
# 答えられるのは端末だけ（Remote Controlはセッションが始まっていないので繋がっていない）で、
# 画面から辿れる出口が無い。**実際にcar-care #27でこの状態のまま止まった。**
#
# 起動する前に分かるなら、止まったセッションを立てるより先に案内を出した方が早い。ここで
# `exit 1`すればpollerがジョブを`failed`にし、この文面が画面に出る（subpc-dispatch-poller.sh）。
#
# **判定は`~/.claude.json`を読むだけ**で、`hasTrustDialogAccepted`を立てはしない。
# 「信頼確認そのものは自動化しない」（docs/multi-agent/session-notify.md）は変えていない。
#
# 古い複製には lib/claude-trust.sh が無い。**そのときは黙って通す**（判定できないだけで、
# 起動を止める理由にはならない。local-repo-resolve.sh と違って無くても動く）。
#
# **Claude Codeで起こすときだけ確かめる**（#2505）。信頼確認はClaude Code固有の画面で、
# Codexには無い（サンドボックスの設定は`--sandbox`で毎回渡している）。
if [[ "$AGENT_KIND" == "claude" && -f "$LIB_DIR/claude-trust.sh" ]]; then
  # shellcheck source=scripts/lib/claude-trust.sh
  source "$LIB_DIR/claude-trust.sh"
  claude_trust_require "$REPO_PATH" "$FULL_NAME" || exit 1
fi

# LANアクセス設定（Windowsの管理者権限が必要）は、wt.exeで開いたタブではUACを承認しても
# 待ちから戻らずタブが固まる。ワンクリック起動では行わない（#1076）。
# コマンドライン引数ではなく環境変数で渡すのは、この指定を解釈しないリポジトリの
# start-issue.shへ渡っても無害にするため（未知のフラグはissue番号として扱われて失敗する）。
export ISSUE_DECK_SKIP_LAN_SETUP=1

# 開発サーバーのポートは「ベース値 + Issue番号」で採番される。どのリポジトリがどの帯を使うかは
# 定義上どのリポジトリ単独でも決められないため、全リポジトリを知る唯一の場所であるissue-deckが
# 持つ（#1073）。実際、issue-deckとshopping-listが同じ4000帯のまま衝突していた。
# 対応表は scripts/local-repo-ports.conf（#1224で`case`文から移した）。
# 表に無いリポジトリへは渡さず、そのリポジトリの既定に任せる。
#
# **契約適合のリポジトリでは、start-issue.sh側の既定値もこの表と同じ値に揃える**（#1178）。
# ターミナル直叩き・tmux経路はここを通らずベース値が渡らないため、既定値がずれていると同じ
# Issueでも起動経路によってポートが変わり、1台に複数リポジトリのセッションが常駐するマシン
# （サブPC）では他リポジトリの帯と衝突する。
if DEV_PORT_BASE="$(local_repo_port_base "$FULL_NAME")"; then
  export ISSUE_DECK_DEV_PORT_BASE="$DEV_PORT_BASE"
fi

# 帯の幅（#2478）。「ベース値 + Issue番号」は帯の幅を超えたら帯の中で折り返すため、採番側は
# ベース値だけでなく幅も要る。3列目が無いリポジトリには渡さず、原則の幅（1000）に任せる。
if DEV_PORT_WIDTH="$(local_repo_port_width "$FULL_NAME")"; then
  export ISSUE_DECK_DEV_PORT_WIDTH="$DEV_PORT_WIDTH"
fi

# execで置き換えるため、以降のtrapは起動先の挙動に委ねる。
trap - EXIT

if [[ "$LAUNCH_MODE" == "generic" ]]; then
  # 汎用ランチャー（#1224）。対象リポジトリには何も追加しない代わりに、worktree作成〜env供給〜
  # 依存インストール〜プロンプト生成〜tmux起動までをissue-deck側で面倒を見る。
  exec bash "$LAUNCHER" "$OWNER" "$REPO" "$ISSUE_NUMBER"
fi

# 契約適合のリポジトリは自前のstart-issue.shがworktree作成〜devサーバー起動〜claude起動まで
# 面倒を見る。
exec bash "$LAUNCHER" "$ISSUE_NUMBER"
