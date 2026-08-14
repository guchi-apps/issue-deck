#!/usr/bin/env bash
# issue-deck-local-session: v2
#
# Issueごとに専用ブランチ・git worktreeを作成し、実装エージェント用のClaude Codeセッションを起動する
#
# 冒頭の `issue-deck-local-session:` は「ローカル起動プロトコル」の版数を宣言するマーカー（#1073）。
# ワンクリック起動の受け口（scripts/start-local-session.sh）と画面がこの行を見て、対応可否を
# 判定する。issue-deck自身もこの契約に従う側なので、他リポジトリと同じように宣言する。
# 約束の内容は docs/multi-agent/local-quick-start.md を参照。
#
# 使い方:
#   scripts/start-issue.sh <issue番号> [issue番号...]
#   scripts/start-issue.sh --prepare-only <issue番号> [issue番号...]
#   scripts/start-issue.sh --recreate <issue番号>      既存worktreeを捨ててdevelopから作り直す
#   scripts/start-issue.sh --no-recreate <issue番号>   作り直しの確認を出さず必ず再利用する
#   scripts/start-issue.sh --no-tmux <issue番号>       tmuxを使わずこのターミナルで起動する
#
# --prepare-only はworktree・ブランチ・起動用プロンプトの準備だけを行い、開発サーバーも
# Claude Codeセッションも起動せずに終了する。VSCodeのClaude Codeタブから `/issue <番号>`
# で呼ぶ用途（既にセッションの中にいるので、さらにclaudeを起動しても意味がない。#1049）。
#
# worktreeが既にある場合は作り直さず再利用する。一度閉じたセッションに戻るための経路であり、
# ワンクリック起動（画面の「ローカルで開始」）を2回目以降に押しても使える（#1076）。
# ただしそのIssueのPRが既にマージ済みなら、developから分岐し直されていない古いブランチのまま
# 作業を始めてしまわないよう警告し、安全に捨てられる場合は作り直すかを尋ねる（#1100）。
# 溜まったworktreeの掃除は scripts/cleanup-worktrees.sh を使う。
#
# 起動時にIssueへ `11.local`（無人実行との二重起動を防ぐ停止フラグ。#1097）を付け、進捗
# （Project Statusの `Planning`/`Implementation`。#1096）を報告する。どの起動経路
# （ターミナル・画面のボタン・`/issue`）もこのスクリプトを通るため、ここに置けば付け忘れが
# 起きない。進捗ラベルは #991 Phase 5（#1010）で廃止しており、報告先はissue-deckの
# 進捗報告API（`POST /api/progress`）だけになっている。
#
# セッションの出口（どこでClaude Codeを走らせるか）は**tmuxがあるかどうかだけ**で決まる（#1178）。
#
#   tmuxがある  Issueごとの新しいtmuxセッション（単一Issueならそのままアタッチする）
#   tmuxが無い  このターミナル（複数Issue指定時は準備だけ行い、手動実行を案内する）
#
# ターミナルを閉じてもSSHが切れてもセッションが残るため、外出先の端末からTailscale SSHで
# 入って実装を始める使い方（#1176 Phase 1）が成立する。WSLでも同じ経路を使う。
# このターミナルで動かしたい場合は `--no-tmux` を付ける。
#
# **Windows Terminalの新しいタブを開く出口は持たない。** 以前は複数Issue指定時に
# `wt.exe -w 0 new-tab` を使っていたが、tmuxで代替できるうえ、Windowsに依存しない経路へ
# 寄せたほうが起動元（サブPC・SSH・無人実行）を選ばないため削除した。
#
# 環境変数:
#   ISSUE_DECK_SKIP_LAN_SETUP=1   LANアクセス設定（Windowsの管理者権限が必要）を行わない
#   ISSUE_DECK_DEV_PORT_BASE=4000 開発サーバーのポートのベース値（未設定ならissue-deckの帯=4000）
#   ISSUE_DECK_DEV_HOST           開発サーバーの待ち受けアドレス（未設定なら全インターフェース）
#
# 前提:
#   - gh コマンドで認証済みであること
#   - pnpm install 済み（本体の node_modules は使わず、worktreeごとに個別インストールする）
#
# 本体リポジトリの作業ツリー（ブランチ・uncommitted changes）には一切触れない。
# develop の最新化は git fetch のみで行い、git worktree add で新しいブランチ・作業ディレクトリを作る。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 端末のタイトル・tmuxのセッション名に出すリポジトリ名。複数リポジトリ・複数Issueのセッションを
# 同時に開くため、「どのリポジトリのどのIssueか」が名前だけで分かるようにする（#1105）。
REPO_NAME="$(basename -s .git "$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || true)")"
if [[ -z "$REPO_NAME" || "$REPO_NAME" == "." ]]; then
  REPO_NAME="$(basename "$ROOT")"
fi
WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
PROMPT_TEMPLATE="$ROOT/scripts/prompts/implementation-agent.md"
PROMPT_DIR="$WORKTREE_BASE/.prompts"

# shellcheck source=scripts/lib/worktree-status.sh
source "$ROOT/scripts/lib/worktree-status.sh"
# 本体の .env.local からworktreeへ環境変数を供給する処理は、汎用ランチャー（#1224）と共有する。
# shellcheck source=scripts/lib/env-file-sync.sh
source "$ROOT/scripts/lib/env-file-sync.sh"
# 起動時の進捗（Project Status）報告も同じく汎用ランチャーと共有する（#1236）。
# shellcheck source=scripts/lib/progress-report.sh
source "$ROOT/scripts/lib/progress-report.sh"
# 個人設定・共有知識がメインPCとサブPCで取り残されていないかの警告（#1190）。
# shellcheck source=scripts/lib/personal-config-sync.sh
source "$ROOT/scripts/lib/personal-config-sync.sh"
# 本体の作業ツリーの scripts/ が origin/develop より古いままになっていないかの警告（#1274）。
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$ROOT/scripts/lib/launcher-scripts-sync.sh"
# 起動プロンプトへ差し込む「今の状況」（#1267）。汎用ランチャーと共有する
# shellcheck source=scripts/lib/prompt-context.sh
source "$ROOT/scripts/lib/prompt-context.sh"

# 端末のタイトル（タブ名）を書き換える。worktree作成・pnpm installの間も、どのIssueの準備中かが
# タイトルから分かるようにする（#1105）。この後Claude Codeが起動すると、同じ書式の`--name`
# （scripts/run-issue-session.sh）が引き継ぐ。
# 端末以外へ出力しているときは、エスケープシーケンスがログに混ざるだけなので何もしない。
set_terminal_title() {
  [[ -t 1 ]] || return 0
  printf '\033]0;%s\007' "$1"
}

# tmuxのセッション名（#1178）。端末のタイトル（`<リポジトリ名> #<番号>`）と同じ内容を、tmuxで使える
# 文字だけで表す。`.`・`:`はtmuxのターゲット指定（`session:window.pane`）の区切りとして
# 解釈されるためセッション名に使えず、空白と`#`も指定のたびにクォートが要る。
# サブPCはissue-deck専用機ではなく他リポジトリのセッションも並ぶため、リポジトリ名を含める。
tmux_session_name() {
  local n="$1"
  local safe_repo="${REPO_NAME//[^A-Za-z0-9_-]/-}"
  printf '%s-issue-%s' "$safe_repo" "$n"
}

PREPARE_ONLY=0
# マージ済みIssueのworktreeを作り直すかどうか。auto=マージ済みを検出したら対話で尋ねる（#1100）
RECREATE_MODE=auto
# セッションの出口。auto=tmuxがあればtmux、無ければこのターミナル（#1178）
TMUX_MODE=auto
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --recreate) RECREATE_MODE=always ;;
    --no-recreate) RECREATE_MODE=never ;;
    --no-tmux) TMUX_MODE=classic ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

# ワンクリック起動（scripts/start-local-session.sh）から呼ばれた場合に立つ。LANアクセス設定は
# Windowsの管理者権限を要求し、wt.exeで開いたタブではUACを承認しても待ちから戻らずタブが
# 固まるため、この経路では行わない（#1076）。
SKIP_LAN_SETUP="${ISSUE_DECK_SKIP_LAN_SETUP:-0}"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/start-issue.sh [--prepare-only] [--recreate|--no-recreate] [--no-tmux] <issue番号> [issue番号...]" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh コマンドが見つかりません。" >&2
  exit 1
fi

if [[ "$PREPARE_ONLY" -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude コマンドが見つかりません。" >&2
  exit 1
fi

# worktreeを作ってから落ちると中途半端な状態が残るため、先に確認する。ワンクリック起動の
# タブは非対話シェルで始まり、nvmを ~/.bashrc に置いていると読まれない（#1085）。
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm コマンドが見つかりません（nvmを使っている場合、非対話シェルでは ~/.bashrc が読まれません）。" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: $PROMPT_TEMPLATE がありません。" >&2
  exit 1
fi

for n in "$@"; do
  if [[ ! "$n" =~ ^[0-9]+$ ]]; then
    echo "Error: issue番号は数字で指定してください: $n" >&2
    exit 1
  fi
done

# 個人設定（`~/.claude/CLAUDE.md`・個人skill）と共有知識が、もう一方のマシンの更新を
# 取り込めていない場合に警告する（#1190）。起動は止めない。
warn_personal_config_drift

# 起動スクリプト・フックの実体は本体の作業ツリーにあり、worktreeを作り直しても新しくならない。
# developへ入った修正が反映されていない場合に警告する（#1274）。起動は止めない。
warn_launcher_scripts_stale "$ROOT"

mkdir -p "$PROMPT_DIR"

# マージ済みPRを持つ既存worktreeを作り直すかどうかを決める（#1100）。作り直す場合のみ0を返す。
# 判断材料と、作り直さない場合の理由もここで表示する。
decide_recreate() {
  local n="$1" merged_pr="$2" dirty_count="$3"
  echo "#$n: 警告: このIssueのPR #$merged_pr は既にマージ済みです。"
  echo "#$n: 　　　 ブランチ issue-$n はdevelopへ取り込み済みで、以降のdevelopの変更を含みません。"

  if [[ "$RECREATE_MODE" == "never" ]]; then
    echo "#$n: --no-recreate が指定されているため、このまま再利用します。"
    return 1
  fi

  # 「入っていないコミットがある」の判定はorigin/developが最新であることが前提。再開経路では
  # まだfetchしていないため、ここで最新化する（失敗しても判定は削除しない側に倒れるだけ）。
  git -C "$ROOT" fetch origin develop >/dev/null 2>&1 || true

  # 作り直す＝worktreeとブランチを消すこと。消して失われるものが残っている場合は作り直さない。
  local blocker=""
  if [[ "$dirty_count" -gt 0 ]]; then
    blocker="未コミットの変更が $dirty_count 件あります"
  elif ! worktree_branch_in_develop "$ROOT" "issue-$n"; then
    blocker="origin/develop に入っていないコミットがあります"
  elif worktree_session_running "$n" "$WORKTREE_BASE"; then
    blocker="このIssueのセッションまたは開発サーバーが動いています"
  fi
  if [[ -n "$blocker" ]]; then
    if [[ "$RECREATE_MODE" == "always" ]]; then
      echo "Error: --recreate が指定されていますが、${blocker}。手動で確認してください。" >&2
      exit 1
    fi
    echo "#$n: ただし${blocker}。作り直すと失われるため、このまま再利用します。"
    return 1
  fi

  if [[ "$RECREATE_MODE" == "always" ]]; then
    return 0
  fi

  # ワンクリック起動のタブは端末を持つので尋ねられる。--prepare-only（Claude Codeのタブから
  # 呼ばれる経路）は端末を持たないため、勝手に消さず案内だけ出して再利用する。
  if [[ ! -t 0 ]]; then
    echo "#$n: 非対話実行のため、このまま再利用します。最新のdevelopから作り直す場合は --recreate を付けて実行してください。"
    return 1
  fi

  local answer
  read -r -p "#$n: worktreeを削除して最新のdevelopから作り直しますか？ [Y/n]: " answer
  case "$answer" in
    [nN]|[nN][oO]) echo "#$n: 既存のworktreeをそのまま使います。"; return 1 ;;
    *) return 0 ;;
  esac
}

# 既存のworktree・ブランチを削除する。作り直し自体は呼び出し元の新規作成経路に任せる。
remove_worktree() {
  local n="$1" dir="$2"
  # 自分の足元を消すとgitの内部状態を巻き込むため、カレントディレクトリが対象の中なら止める。
  local current_dir
  current_dir="$(pwd -P)"
  if [[ "$current_dir" == "$dir" || "$current_dir" == "$dir"/* ]]; then
    echo "Error: 削除対象のworktreeの中で実行されているため作り直せません: $dir" >&2
    echo "       別のディレクトリ（例: $ROOT）へ移動してから実行してください。" >&2
    exit 1
  fi
  echo "#$n: 既存のworktree・ブランチを削除しています..."
  if ! git -C "$ROOT" worktree remove "$dir"; then
    echo "Error: worktreeの削除に失敗しました: $dir" >&2
    exit 1
  fi
  # コミットがすべて origin/develop に入っていることを確認済みなので -D でよい（-d は
  # 現在のHEADを基準に判定するため、本体が別のIssueブランチを開いていると消せない）。
  git -C "$ROOT" branch -D "issue-$n" >/dev/null
  rm -f "$WORKTREE_BASE/.dev-servers/issue-$n.log" "$WORKTREE_BASE/.dev-servers/issue-$n.pid"
}

# 起動時にIssueへ `11.local` を付ける（#1097）。
#
# ローカルセッションで対応中であることを示す停止フラグで、付いている間は無人実行
# （`claude-issue-dispatch.yml`）がこのIssueに手を出さない。
#
# ラベル付与に失敗しても起動は止めない（起動できないより、記録が遅れる方が軽い。画面の
# 「ローカルで開始」ボタンも同じ方針を取っている）。
apply_start_labels() {
  local n="$1"
  # 既に付いているラベル名（1行1つ）。判定に使うだけなのでIssue取得のJSONから読み、
  # 追加のAPI呼び出しはしない。
  local existing="$2"

  if printf '%s\n' "$existing" | grep -Fxq "11.local"; then
    echo "#$n: 11.local は付与済みです。"
    return 0
  fi

  if gh issue edit "$n" --repo guchi-apps/issue-deck --add-label "11.local" >/dev/null; then
    echo "#$n: ラベルを付与しました（11.local）。"
  else
    echo "#$n: 警告: ラベル（11.local）の付与に失敗しました。手動で付けてください。" >&2
  fi
}

# 起動時の進捗（Project Status）の報告は scripts/lib/progress-report.sh が持つ（#1236）。
# 報告先と鍵の探し方（環境変数 → 本体の`.env.local` → サブPCの`dispatch.env`）もそちらを参照。

# issue番号ごとにworktree・ブランチを準備し、起動用プロンプトを生成する。
# 戻り値として WORKTREE_DIR / PROMPT_FILE / DEV_PORT をグローバル変数に設定する。
prepare_issue() {
  local n="$1"
  WORKTREE_DIR="$WORKTREE_BASE/issue-$n"
  PROMPT_FILE="$PROMPT_DIR/issue-$n.md"
  set_terminal_title "$REPO_NAME #$n"

  # 既存のworktreeは作り直さず再利用する（#1076）。ただしworktreeとして壊れている場合や
  # 別ブランチを開いている場合は、意図しない場所で作業を続けることになるため止める。
  local reuse_worktree=0
  if [[ -e "$WORKTREE_DIR" ]]; then
    if ! git -C "$WORKTREE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "Error: $WORKTREE_DIR はgitの作業ツリーではありません。中身を確認して削除してください。" >&2
      exit 1
    fi
    local current_branch
    current_branch="$(git -C "$WORKTREE_DIR" branch --show-current)"
    if [[ "$current_branch" != "issue-$n" ]]; then
      echo "Error: $WORKTREE_DIR が開いているのは issue-$n ではなく ${current_branch:-(デタッチHEAD)} です。" >&2
      exit 1
    fi
    reuse_worktree=1
    echo "#$n: 既存のworktreeを再利用します（$WORKTREE_DIR）。"
    local dirty_count
    dirty_count="$(worktree_dirty_count "$WORKTREE_DIR")"
    if [[ "$dirty_count" -gt 0 ]]; then
      echo "#$n: 未コミットの変更が $dirty_count 件あります。前回の続きから作業してください。"
    fi

    # マージ済みのIssueで再開すると、developから分岐し直されないまま古いブランチで作業を
    # 始めてしまう。#1076で再開できるようにしたぶん、黙って進むと気づきにくい（#1100）。
    local merged_pr
    merged_pr="$(worktree_merged_pr "$n")"
    if [[ -n "$merged_pr" ]] && decide_recreate "$n" "$merged_pr" "$dirty_count"; then
      remove_worktree "$n" "$WORKTREE_DIR"
      reuse_worktree=0
    fi
  fi

  echo "#$n: Issue内容を取得しています..."
  local issue_json
  if ! issue_json="$(gh issue view "$n" --repo guchi-apps/issue-deck --json number,title,body,labels,comments)"; then
    echo "Error: issue #$n の取得に失敗しました。" >&2
    exit 1
  fi

  # ラベル付与と進捗の報告は、worktree作成やpnpm installより先に行う。二重起動の停止フラグ
  # （`11.local`）は早く立つほど効くうえ、以降の重い処理が失敗しても着手した記録は残る。
  local issue_labels
  if issue_labels="$(printf '%s' "$issue_json" | python3 -c 'import json, sys; print("\n".join(l["name"] for l in json.load(sys.stdin).get("labels") or []))')"; then
    apply_start_labels "$n" "$issue_labels"
    report_start_progress "$ROOT" "guchi-apps/issue-deck" "$n" "$issue_labels"
  else
    # 解析できないまま進めると、`21.plan-required`の有無を取り違えて計画フェーズを飛ばしかねない
    # のでスキップする。
    echo "#$n: 警告: ラベル一覧を解析できなかったため、起動時のラベル付与・進捗の報告をスキップします。" >&2
  fi

  if [[ "$reuse_worktree" -eq 0 ]]; then
    echo "#$n: develop を最新化しています..."
    git -C "$ROOT" fetch origin develop

    echo "#$n: worktree・ブランチ issue-$n を作成しています..."
    if ! git -C "$ROOT" worktree add "$WORKTREE_DIR" -b "issue-$n" origin/develop; then
      echo "Error: worktree/ブランチの作成に失敗しました（ブランチ issue-$n が既に存在する可能性があります）。" >&2
      echo "       マージ済みのブランチが残っているだけなら scripts/cleanup-worktrees.sh --issue $n で掃除できます。" >&2
      exit 1
    fi
  fi

  # 再開時は既存の .env.local を尊重する（ローカルで書き換えている場合があるため）。
  # 無いときだけ本体からコピーし、既にある場合は不足しているキーだけを補う（#1099）。
  if [[ ! -f "$WORKTREE_DIR/.env.local" ]]; then
    if [[ -f "$ROOT/.env.local" ]]; then
      cp "$ROOT/.env.local" "$WORKTREE_DIR/.env.local"
    else
      echo "警告: $ROOT/.env.local が無いため .env.local をコピーしませんでした。" >&2
    fi
  elif [[ -f "$ROOT/.env.local" ]]; then
    sync_missing_env_keys "$n" "$ROOT/.env.local" "$WORKTREE_DIR/.env.local"
  fi

  # 開発サーバーのポートをIssueごとに一意にする（複数worktreeで同時にpnpm devしても衝突しないように）。
  # ワンクリック起動からはissue-deck側の受け口がベース値を渡してくる。リポジトリごとの帯を
  # 一箇所で管理するための約束で（#1073）、渡されない場合は既定の4000を使う。
  #
  # **既定値はissue-deck自身の帯（4000）と一致させる**（#1178）。ターミナル直叩き・tmux経路は
  # 受け口を通らずベース値が渡ってこないため、既定値が帯とずれていると、同じIssue番号でも
  # 起動経路によって別のポートになる。1台のマシンに複数リポジトリのセッションが常駐する
  # サブPCでは、そのずれがそのまま他リポジトリの帯との衝突になる。帯の一覧は
  # docs/multi-agent/local-quick-start.md を参照。
  DEV_PORT=$(( ${ISSUE_DECK_DEV_PORT_BASE:-4000} + n ))
  if [[ -f "$WORKTREE_DIR/.env.local" ]]; then
    # `sed`で消して追記する形にすると、再開のたびに先頭改行が積もって空行が増える（実測で
    # 何度も再開したworktreeだけ空行が4行多かった）。既存行があれば置換する共通スクリプトを使う。
    bash "$ROOT/scripts/update-env-file.sh" "$WORKTREE_DIR/.env.local" PORT "$DEV_PORT"
  fi
  echo "#$n: 開発サーバーはポート $DEV_PORT を使用します（http://localhost:$DEV_PORT）"

  SSLIP_URL=""
  if [[ "$PREPARE_ONLY" -eq 1 ]]; then
    # 開発サーバーを起動しないので、この時点でポートフォワーディングを設定する意味がない。
    # UACダイアログを出さずに済ませる（必要になったらdevサーバー起動時に設定する）。
    echo "#$n: --prepare-only のためLANアクセス設定はスキップします。"
  elif [[ "$SKIP_LAN_SETUP" != "0" ]]; then
    # ワンクリック起動経路。UACを承認しても待ちから戻らずタブが固まるため行わない（#1076）。
    echo "#$n: LANアクセス設定はスキップします（LAN内の別端末から見る場合は scripts/setup-lan-access.sh $DEV_PORT を実行してください）。"
  elif ! command -v powershell.exe >/dev/null 2>&1; then
    # WSL以外（サブPCのUbuntu等）。ここで必要だったのはWSL2の内部NATを越えるための
    # Windows側ポートフォワーディングで、素のLinuxには対応物が無い。開発サーバーは最初から
    # 全インターフェースで待ち受けるため、同一LAN・tailnetの端末からそのまま見える（#1178）。
    # setup-lan-access.sh も同じ判定で何もせず終わるが、ここで分けておくと何が行われなかったかが
    # ログに残る。
    echo "#$n: LANアクセス設定はスキップします（WSL以外の環境では不要。開発サーバーは全インターフェースで待ち受けます）。"
  else
    echo "#$n: LANアクセス用のポートフォワーディングを設定しています（Windowsの管理者権限が必要です）..."
    if bash "$ROOT/scripts/setup-lan-access.sh" "$DEV_PORT"; then
      WSL_IP="$(ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' || true)"
      if [[ -n "$WSL_IP" ]]; then
        SSLIP_URL="http://${WSL_IP}.sslip.io:${DEV_PORT}"
      fi
    else
      echo "#$n: 警告: LANアクセス設定に失敗しました。localhostでの確認は引き続き可能です。" >&2
    fi
  fi

  echo "#$n: pnpm install しています..."
  (cd "$WORKTREE_DIR" && pnpm install)

  echo "#$n: 起動用プロンプトを生成しています..."
  # 起動プロンプトへ差し込む「今の状況」（#1267）。集めるだけで判断はしない
  local issue_relations concurrent_work
  issue_relations="$(prompt_context_relations "guchi-apps/issue-deck" "$n")"
  concurrent_work="$(prompt_context_concurrent "guchi-apps/issue-deck" "$n" "$WORKTREE_DIR" develop)"
  local issue_json_file
  issue_json_file="$(mktemp)"
  printf '%s' "$issue_json" >"$issue_json_file"
  local dev_log="$WORKTREE_BASE/.dev-servers/issue-$n.log"
  python3 - "$issue_json_file" "$PROMPT_TEMPLATE" "$DEV_PORT" "$SSLIP_URL" "$dev_log" "$PREPARE_ONLY" "$WORKTREE_DIR" "$issue_relations" "$concurrent_work" >"$PROMPT_FILE" <<'PY'
import json
import sys

issue_json_path, template_path, dev_port, sslip_url, dev_log = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
# --prepare-only では開発サーバーを起動しない。プロンプト側の「起動済み」という記述が
# 嘘にならないよう、この値で文面を分ける。
prepare_only = sys.argv[6] == "1"
worktree_dir = sys.argv[7]
issue_relations = sys.argv[8]
concurrent_work = sys.argv[9]

with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

label_names = {l["name"] for l in issue.get("labels", [])}
labels = ", ".join(sorted(label_names)) or "(なし)"

# 別端末から見るための案内。**メインPC（WSL）はsslip.io、サブPCはtailscale serve**（#1265）で
# 経路が違うため、決め打ちで書かない。tailnetのURLは起動時にしか分からない（ホスト名が
# ホスト依存）ので、起動ログの行を見るよう促す。
if sslip_url:
    sslip_note = f"（スマホ等、同一LAN上の別端末から確認する場合は`{sslip_url}`を使う）"
else:
    sslip_note = (
        "（別端末から確認する場合は、起動ログの「開発サーバーをtailnetへ公開しました」の行に"
        "出ているtailnetのURLを使う。出ていなければこのホストからは公開できていない）"
    )

if prepare_only:
    dev_server_state = (
        "このworktree用の開発サーバーは**まだ起動していません**。画面確認が必要になったら "
        "`cd {worktree} && pnpm dev` でバックグラウンド起動してください（ポート`{port}`は"
        "`.env.local`に設定済みなので、そのまま`pnpm dev`でよい）"
    ).format(worktree=worktree_dir, port=dev_port)
else:
    # 開発サーバーは一定時間アクセスが無いと回収される（#1223）。落ちていることを想定外の事故と
    # 受け取って調査に入られると無駄なので、起こし方まで先に伝えておく。
    #
    # **`pnpm dev`だけで起こし直せる**（#1329）。tailnetへ公開しているポートでは、`dev.sh`が
    # 待ち受けを`127.0.0.1`へ倒して`EADDRINUSE`を避ける。ここに別のコマンドを書く必要はない。
    dev_server_state = (
        "このworktree用の開発サーバーはセッション開始時に自動起動済み（ログ: `{dev_log}`）。"
        "ただし**一定時間アクセスが無いと自動で停止される**ため、画面確認のときに繋がらなければ "
        "`cd {worktree} && pnpm dev` で起こしてよい（tailnetへ公開している場合も同じコマンドでよく、"
        "起こし直せばtailnetのURLからも再び見える。停止した理由はログの末尾に残っている）"
    ).format(dev_log=dev_log, worktree=worktree_dir)

if "23.preview-required" in label_names:
    preview_instructions = (
        "このIssueには`23.preview-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に次の手順を行ってください。\n\n"
        "1. `http://localhost:{port}` で実際の画面を確認する"
        "（{dev_server_state}）{sslip_note}\n"
        "2. 確認した画面・操作手順と**別端末から開けるURL**をユーザーに提示し、問題ないか"
        "明示的な承認を得る（ユーザーは外出先のスマホから開くため、`localhost`のURLでは届かない）\n"
        "3. 承認が得られてから初めてPRを作成する（ローカル実行では、承認が得られるまで応答を止めて待つ。"
        "無人実行の場合は`00.check-user`を付与して停止し、承認後に再開する）"
    ).format(port=dev_port, sslip_note=sslip_note, dev_server_state=dev_server_state)
else:
    preview_instructions = (
        "このworktreeの開発サーバー（`pnpm dev`）はポート`{port}`を使います"
        "（他Issueのworktreeと同時に起動しても衝突しません）。{dev_server_state}。"
        "画面に関わる変更を行った場合、PR本文の「確認方法」に次の情報を含めてください。\n\n"
        "- アクセスURL（`http://localhost:{port}`）{sslip_note}\n"
        "- 実際に確認すべき画面・操作手順\n\n"
        "承認待ちで止まる必要はなく、そのままPR作成まで進めてよいです。"
    ).format(port=dev_port, sslip_note=sslip_note, dev_server_state=dev_server_state)

if "24.screenshot-required" in label_names:
    screenshot_instructions = (
        "このIssueには`24.screenshot-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に次の手順を行ってください。\n\n"
        f"1. `run`スキル等を使って開発サーバー（ポート`{dev_port}`）上で変更箇所のスクリーンショットを取得する"
        "（Playwright等の新規依存関係の追加が必要な場合は、追加前に必ずユーザーに確認する）\n"
        "2. 取得したスクリーンショットをユーザーに提示し、問題ないか明示的な承認を得る\n"
        "3. 承認が得られてから初めてPRを作成する（ローカル実行では、承認が得られるまで応答を止めて待つ。"
        "無人実行の場合は`00.check-user`を付与して停止し、承認後に再開する）"
    )
else:
    screenshot_instructions = (
        "このIssueには`24.screenshot-required`ラベルが付いていないため、"
        "Playwright等によるスクリーンショットの自動取得は不要です（トークン消費が大きいため）。"
    )

comments = issue.get("comments", [])
if comments:
    comment_text = "\n\n".join(
        "- {login} ({created_at}):\n{body}".format(
            login=(c.get("author") or {}).get("login", "unknown"),
            created_at=c.get("createdAt", ""),
            body=c.get("body", ""),
        )
        for c in comments
    )
else:
    comment_text = "(コメントなし)"

result = (
    template.replace("{{ISSUE_NUMBER}}", str(issue["number"]))
    .replace("{{ISSUE_TITLE}}", issue["title"])
    .replace("{{ISSUE_LABELS}}", labels)
    .replace("{{ISSUE_BODY}}", issue.get("body") or "(本文なし)")
    .replace("{{ISSUE_COMMENTS}}", comment_text)
    .replace("{{ISSUE_RELATIONS}}", issue_relations or "（取得できませんでした）")
    .replace("{{CONCURRENT_WORK}}", concurrent_work or "（取得できませんでした）")
    .replace("{{DEV_PORT}}", dev_port)
    .replace("{{PREVIEW_INSTRUCTIONS}}", preview_instructions)
    .replace("{{SCREENSHOT_INSTRUCTIONS}}", screenshot_instructions)
)
sys.stdout.write(result)
PY
  rm -f "$issue_json_file"
}

# tmuxセッションへ引き継ぐ環境変数（#1178）。新しいセッションはtmuxサーバー側の環境を
# 引き継ぐため、このプロセスのexportがそのまま届くとは限らない。値は%qでクォートして埋める。
# 設定されているものだけを渡し、未設定のものは新しいシェル側の既定に任せる。
build_env_prefix() {
  local var value prefix=""
  # ISSUE_DECK_SESSION_REAPABLE / ISSUE_DECK_SESSION_STATE_DIR はセッションの自動回収（#1256）用。
  # 前者はpollerがジョブとして起動した経路でだけ渡ってくる印で、tmuxの中まで届かないと
  # 記述子に載らず、回収の対象にならない。
  for var in ISSUE_DECK_WORKTREE_BASE ISSUE_DECK_SHARED_CONTEXT_DIR ISSUE_DECK_SKIP_LAN_SETUP \
    ISSUE_DECK_DEV_HOST ISSUE_DECK_SESSION_REAPABLE ISSUE_DECK_SESSION_STATE_DIR; do
    value="${!var:-}"
    [[ -n "$value" ]] || continue
    prefix+="export $var=$(printf '%q' "$value"); "
  done
  printf '%s' "$prefix"
}

# 単一worktree内で開発サーバー起動〜claude起動〜終了時のdevサーバー停止までを行う
# run-issue-session.sh を起動するコマンド文字列を作る（PROMPT_FILEのパスのみを埋め込み、
# Issue本文・コメントなどの外部由来テキストはコマンド文字列に直接展開しない）。
build_claude_cmd() {
  local issue_number="$1"
  local worktree_dir="$2"
  local dev_port="$3"
  local prompt_file="$4"
  printf "%scd %q && bash %q %q %q %q" "$(build_env_prefix)" "$worktree_dir" "$ROOT/scripts/run-issue-session.sh" "$issue_number" "$dev_port" "$prompt_file"
}

# tmuxの新しいセッションでrun-issue-session.shを起動する（#1178）。
start_tmux_session() {
  local n="$1" session="$2" worktree_dir="$3" cmd="$4"

  # 同名のセッションが動いていれば作らない。再開（#1076）で2回目に起動したときに、
  # 前のセッションを残したまま同じIssueのセッションが二重に立つのを防ぐ。
  if tmux has-session -t "=$session" 2>/dev/null; then
    # ただし後述の`remain-on-exit`で残した「死んだペインだけのセッション」は、動いているのでは
    # なく前回の終了の痕跡なので、最後の出力を見せてから畳んで作り直す。残したままだと
    # 再実行しても「既に動いています」で止まり、二度と起動できない。
    local alive_panes
    alive_panes="$(tmux list-panes -s -t "=$session" -F '#{pane_dead}' 2>/dev/null | grep -cv '^1$' || true)"
    if [[ "${alive_panes:-0}" -eq 0 ]]; then
      # tmux 3.2以降は異常終了時だけ残る。3.2未満（`on`へフォールバックした環境）では
      # 正常終了でも残るため、「異常終了した」とは断定しない。終了コードは下の出力に出る。
      echo "#$n: 前回のtmuxセッション「$session」は終了したまま残っていました。最後の出力:"
      # capture-paneはペイン指定なので、セッション指定の`=`接頭辞ではなく`<セッション名>:`
      # （そのセッションの現在のウィンドウ＝アクティブなペイン）で指す。
      tmux capture-pane -p -t "$session:" 2>/dev/null | grep -v '^$' | tail -n 15 | sed 's/^/    /' || true
      tmux kill-session -t "=$session" >/dev/null 2>&1 || true
    else
      echo "#$n: tmuxセッション「$session」は既に動いています。新しくは起動しません。"
      return 0
    fi
  fi

  # tmuxはコマンドを既定シェルで直接実行し、**ログインシェルとしては起動しない**。
  # `~/.profile`系が読まれずPATHに`~/.local/bin`が乗らないため、そのままではclaudeが
  # 見つからずセッションが即死する（#1177で実際に踏んだ）。`bash -lc`を明示して、
  # node/pnpm/claude/gh とトークン類をまとめてログインシェルに解決させる。個別にPATHを
  # 足す方法もあるが、後から増えた環境変数を取りこぼす。
  if ! tmux new-session -d -s "$session" -c "$worktree_dir" "bash -lc $(printf '%q' "$cmd")"; then
    echo "Error: tmuxセッション「$session」の起動に失敗しました。" >&2
    return 1
  fi

  # 異常終了時にペインを残す。既定ではコマンドの終了と同時にセッションごと消えるため、
  # **エラーメッセージが一切残らない**（#1177で原因究明に手間取った）。`failed`はtmux 3.2以降で、
  # 異常終了のときだけ残す。古いtmux（メインPCのWSLは3.0a）では`unknown value`で失敗するため、
  # 常に残す`on`へ落とす。この場合は正常終了でもセッションが残るが、次回同じIssueで起動した
  # ときに上の分岐が畳んで作り直すので、溜まったまま起動できなくなることはない。
  #
  # これはウィンドウのオプションなので、対象はセッション名ではなく`<セッション名>:`
  # （＝そのセッションの現在のウィンドウ）で指す。セッション指定の`=`接頭辞は付かない。
  tmux set-option -t "$session:" -w remain-on-exit failed >/dev/null 2>&1 ||
    tmux set-option -t "$session:" -w remain-on-exit on >/dev/null 2>&1 || true
}

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  for n in "$@"; do
    prepare_issue "$n"
    echo "#$n: 準備が完了しました。"
    echo "  worktree: $WORKTREE_DIR"
    echo "  プロンプト: $PROMPT_FILE"
    echo "  開発サーバー用ポート: $DEV_PORT（未起動）"
  done
  exit 0
fi

# セッションの出口を決める（#1178）。**tmuxがあれば必ずtmux。**
# Windows Terminalのタブを開く出口は持たない（WSLでもtmuxを使う）。
TMUX_AVAILABLE=0
if command -v tmux >/dev/null 2>&1; then
  TMUX_AVAILABLE=1
fi

LAUNCHER=tmux
if [[ "$TMUX_MODE" == "classic" || "$TMUX_AVAILABLE" -eq 0 ]]; then
  if [[ "$TMUX_MODE" != "classic" ]]; then
    echo "警告: tmux が見つからないため、このターミナルで起動します（切断するとセッションも終了します）。" >&2
  fi
  LAUNCHER=classic
fi

if [[ "$LAUNCHER" == "tmux" ]]; then
  # Issueごとに独立したtmuxセッションを立てる。ターミナルを閉じてもSSHが切れても残るため、
  # 外出先の端末から入って実装を始め、切断して後から戻る使い方ができる（#1176 Phase 1）。
  for n in "$@"; do
    prepare_issue "$n"
    session="$(tmux_session_name "$n")"
    echo "#$n: tmuxセッション「$session」で開発サーバーとClaude Codeセッションを起動します..."
    start_tmux_session "$n" "$session" "$WORKTREE_DIR" \
      "$(build_claude_cmd "$n" "$WORKTREE_DIR" "$DEV_PORT" "$PROMPT_FILE")"
  done

  echo
  echo "起動したセッションはこのターミナルを閉じても（SSHが切れても）動き続けます。"
  # 単一Issueで、端末があり、まだtmuxの外にいる場合はそのままアタッチする。ターミナルから
  # 直接叩いたときに、これまでどおり目の前でセッションが始まったように見える。
  if [[ $# -eq 1 && -t 0 && -t 1 && -z "${TMUX:-}" ]]; then
    echo "アタッチします（切り離すには Ctrl-b d）..."
    exec tmux attach-session -t "=$(tmux_session_name "$1")"
  fi
  for n in "$@"; do
    if [[ -n "${TMUX:-}" ]]; then
      # tmuxの中からは入れ子でアタッチできない。今いるクライアントの切り替えを案内する。
      echo "  #$n: tmux switch-client -t $(tmux_session_name "$n")"
    else
      echo "  #$n: tmux attach -t $(tmux_session_name "$n")"
    fi
  done
  exit 0
fi

if [[ $# -eq 1 ]]; then
  n="$1"
  prepare_issue "$n"
  echo "#$n: 開発サーバーを自動起動し、Claude Codeセッションを起動します（このターミナルで実行）..."
  cd "$WORKTREE_DIR"
  exec bash "$ROOT/scripts/run-issue-session.sh" "$n" "$DEV_PORT" "$PROMPT_FILE"
fi

# tmuxが無い環境で複数Issueを指定した場合。1つのターミナルでは1セッションしか動かせないため、
# 準備だけを行い、残りは手動実行に委ねる（別々のターミナルで叩けば並行できる）。
for n in "$@"; do
  prepare_issue "$n"
  echo "#$n: worktreeの準備ができました。以下を手動で実行してください:"
  echo "  cd \"$WORKTREE_DIR\" && bash \"$ROOT/scripts/run-issue-session.sh\" \"$n\" \"$DEV_PORT\" \"$PROMPT_FILE\""
done
