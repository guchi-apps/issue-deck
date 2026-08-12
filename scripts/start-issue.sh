#!/usr/bin/env bash
# issue-deck-local-session: v1
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
# 環境変数:
#   ISSUE_DECK_SKIP_LAN_SETUP=1   LANアクセス設定（Windowsの管理者権限が必要）を行わない
#   ISSUE_DECK_DEV_PORT_BASE=4000 開発サーバーのポートのベース値（未設定なら既定の4000）
#
# 前提:
#   - gh コマンドで認証済みであること
#   - pnpm install 済み（本体の node_modules は使わず、worktreeごとに個別インストールする）
#
# 本体リポジトリの作業ツリー（ブランチ・uncommitted changes）には一切触れない。
# develop の最新化は git fetch のみで行い、git worktree add で新しいブランチ・作業ディレクトリを作る。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Windows Terminalのタブ名に出すリポジトリ名。複数リポジトリ・複数Issueのタブを同時に開くため、
# 「どのリポジトリのどのIssueか」がタブだけで分かるようにする（#1105）。
REPO_NAME="$(basename -s .git "$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || true)")"
if [[ -z "$REPO_NAME" || "$REPO_NAME" == "." ]]; then
  REPO_NAME="$(basename "$ROOT")"
fi
WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
PROMPT_TEMPLATE="$ROOT/scripts/prompts/implementation-agent.md"
PROMPT_DIR="$WORKTREE_BASE/.prompts"

# shellcheck source=scripts/lib/worktree-status.sh
source "$ROOT/scripts/lib/worktree-status.sh"

# 端末のタイトル（Windows Terminalのタブ名）を書き換える。worktree作成・pnpm installの間も
# どのIssueの準備中かがタブから分かるようにする（#1105）。この後Claude Codeが起動すると、
# 同じ書式の`--name`（scripts/run-issue-session.sh）が引き継ぐ。
# 端末以外へ出力しているときは、エスケープシーケンスがログに混ざるだけなので何もしない。
set_terminal_title() {
  [[ -t 1 ]] || return 0
  printf '\033]0;%s\007' "$1"
}

PREPARE_ONLY=0
# マージ済みIssueのworktreeを作り直すかどうか。auto=マージ済みを検出したら対話で尋ねる（#1100）
RECREATE_MODE=auto
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --recreate) RECREATE_MODE=always ;;
    --no-recreate) RECREATE_MODE=never ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

# ワンクリック起動（scripts/start-local-session.sh）から呼ばれた場合に立つ。LANアクセス設定は
# Windowsの管理者権限を要求し、wt.exeで開いたタブではUACを承認しても待ちから戻らずタブが
# 固まるため、この経路では行わない（#1076）。
SKIP_LAN_SETUP="${ISSUE_DECK_SKIP_LAN_SETUP:-0}"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/start-issue.sh [--prepare-only] [--recreate|--no-recreate] <issue番号> [issue番号...]" >&2
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

# `.env.local` から1つのキーの値を読む（存在しなければ空文字）。値はログに出さない。
read_env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n1 | sed -e 's/^"//' -e 's/"$//'
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

# 起動時にIssueの進捗（Project Status）を報告する（#1096。#1010でラベル付与から置き換え）。
#
# `21.plan-required` が付いていれば `planning`、無ければ `implementation` を報告する。
#
# **既に進捗が始まっている場合は触らない。** 再開（#1076）で2回目以降に起動したときに、
# `Develop PR`まで進んだIssueを`Implementation`へ巻き戻さないため。判定にはissue-deckの
# 進捗問い合わせAPI（`GET /api/progress`）を使う。
#
# 報告先と鍵は本体の `.env.local` から読む（`APP_BASE_URL`・`PROGRESS_REPORT_SECRET`）。
# **どちらかが無ければ何もせず案内だけ出す。** ローカル環境に鍵を持たない使い方
# （issue-deckの画面やカンバンから進捗を動かす）も成立するため、起動を止める理由にしない。
report_start_progress() {
  local n="$1"
  local existing="$2"
  local base_url secret desired
  base_url="$(read_env_value "$ROOT/.env.local" APP_BASE_URL)"
  secret="$(read_env_value "$ROOT/.env.local" PROGRESS_REPORT_SECRET)"
  if [[ -z "$base_url" || -z "$secret" ]]; then
    echo "#$n: 進捗（Project Status）は報告しませんでした（.env.local に APP_BASE_URL / PROGRESS_REPORT_SECRET がありません）。"
    echo "     issue-deckの画面の「実装を開始」ボタン、またはカンバンでカードを動かして進捗を進めてください。"
    return 0
  fi

  local current
  current="$(curl -sS -m 20 -H "Authorization: Bearer $secret" \
    "$base_url/api/progress?repository=guchi-apps/issue-deck&issue=$n" 2>/dev/null \
    | jq -r 'select(.available == true) | .status // empty' 2>/dev/null || true)"
  if [[ -n "$current" && "$current" != "ready" ]]; then
    echo "#$n: 進捗は既に開始済みです（$current）。巻き戻さないため報告しません。"
    return 0
  fi

  if printf '%s\n' "$existing" | grep -Fxq "21.plan-required"; then
    desired="planning"
  else
    desired="implementation"
  fi

  local code
  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
    -X POST "$base_url/api/progress" \
    -H "Authorization: Bearer $secret" \
    -H "Content-Type: application/json" \
    -d "{\"repository\":\"guchi-apps/issue-deck\",\"issue\":$n,\"status\":\"$desired\"}" 2>/dev/null)" || code=000
  if [[ "$code" == "200" ]]; then
    echo "#$n: 進捗を $desired として報告しました。"
  else
    echo "#$n: 警告: 進捗（$desired）の報告に失敗しました（HTTP $code）。issue-deckの画面から進めてください。" >&2
  fi
}

# 本体の .env.local にあってworktree側に無いキーだけを、値ごと追記する（#1099）。
# worktreeの .env.local は作成時のコピーで固定されるため、本体に後から足した環境変数が
# 既存のworktreeへ届かず、本体と違う挙動で画面確認をすることになっていた。
# 既存キーの値には触れない（ローカルで書き換えている場合を壊さないため）。値はログに出さず、
# 追記したキー名だけを表示する。
sync_missing_env_keys() {
  local issue_number="$1"
  local source_file="$2"
  local target_file="$3"
  # 補完に失敗してもセッションの起動自体は妨げない（起動できない方が困るため）。
  local added
  if ! added="$(python3 - "$source_file" "$target_file" <<'PY'
import pathlib
import re
import sys

source_path = pathlib.Path(sys.argv[1])
target_path = pathlib.Path(sys.argv[2])

# PORTはworktreeごとに採番して別途書き込むため、同期の対象から外す。
EXCLUDED_KEYS = {"PORT"}

ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
# コメントアウトされた代入は「意図的に無効化している」とみなし、上書き復活させない。
COMMENTED_ASSIGNMENT = re.compile(r"^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")

source_lines = source_path.read_text(encoding="utf-8").splitlines()
target_text = target_path.read_text(encoding="utf-8")

existing = set()
for line in target_text.splitlines():
    matched = ASSIGNMENT.match(line) or COMMENTED_ASSIGNMENT.match(line)
    if matched:
        existing.add(matched.group(1))

added_keys = []
appended_lines = []
for i, line in enumerate(source_lines):
    matched = ASSIGNMENT.match(line)
    if not matched:
        continue
    key = matched.group(1)
    if key in EXCLUDED_KEYS or key in existing:
        continue
    # 何のためのキーかが分かるよう、直前の連続するコメント行も一緒に持っていく。
    start = i
    while start > 0 and source_lines[start - 1].lstrip().startswith("#"):
        start -= 1
    appended_lines.extend(source_lines[start:i])
    appended_lines.append(line)
    added_keys.append(key)

if appended_lines:
    if target_text and not target_text.endswith("\n"):
        target_text += "\n"
    if target_text and not target_text.endswith("\n\n"):
        target_text += "\n"
    target_path.write_text(target_text + "\n".join(appended_lines) + "\n", encoding="utf-8")

# 値は出力しない（キー名のみ）。
sys.stdout.write(" ".join(added_keys))
PY
  )"; then
    echo "警告: $target_file の不足キーの補完に失敗しました。本体の .env.local と見比べてください。" >&2
    return 0
  fi
  if [[ -n "$added" ]]; then
    echo "#$issue_number: .env.local に不足していたキーを本体から追記しました: $added"
  fi
}

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
    report_start_progress "$n" "$issue_labels"
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
  local issue_json_file
  issue_json_file="$(mktemp)"
  printf '%s' "$issue_json" >"$issue_json_file"
  local dev_log="$WORKTREE_BASE/.dev-servers/issue-$n.log"
  python3 - "$issue_json_file" "$PROMPT_TEMPLATE" "$DEV_PORT" "$SSLIP_URL" "$dev_log" "$PREPARE_ONLY" "$WORKTREE_DIR" >"$PROMPT_FILE" <<'PY'
import json
import sys

issue_json_path, template_path, dev_port, sslip_url, dev_log = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
# --prepare-only では開発サーバーを起動しない。プロンプト側の「起動済み」という記述が
# 嘘にならないよう、この値で文面を分ける。
prepare_only = sys.argv[6] == "1"
worktree_dir = sys.argv[7]

with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

label_names = {l["name"] for l in issue.get("labels", [])}
labels = ", ".join(sorted(label_names)) or "(なし)"

if sslip_url:
    sslip_note = f"（スマホ等、同一LAN上の別端末から確認する場合は`{sslip_url}`を使う）"
else:
    sslip_note = ""

if prepare_only:
    dev_server_state = (
        "このworktree用の開発サーバーは**まだ起動していません**。画面確認が必要になったら "
        "`cd {worktree} && pnpm dev` でバックグラウンド起動してください（ポート`{port}`は"
        "`.env.local`に設定済みなので、そのまま`pnpm dev`でよい）"
    ).format(worktree=worktree_dir, port=dev_port)
else:
    dev_server_state = (
        "このworktree用の開発サーバーはセッション開始時に自動起動済み（ログ: `{dev_log}`）"
    ).format(dev_log=dev_log)

if "23.preview-required" in label_names:
    preview_instructions = (
        "このIssueには`23.preview-required`ラベルが付いています。実装・テストが完了したら、"
        "PRを作成する**前**に次の手順を行ってください。\n\n"
        "1. `http://localhost:{port}` で実際の画面を確認する"
        "（{dev_server_state}）{sslip_note}\n"
        "2. 確認した画面・操作手順をユーザーに提示し、問題ないか明示的な承認を得る\n"
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
    .replace("{{DEV_PORT}}", dev_port)
    .replace("{{PREVIEW_INSTRUCTIONS}}", preview_instructions)
    .replace("{{SCREENSHOT_INSTRUCTIONS}}", screenshot_instructions)
)
sys.stdout.write(result)
PY
  rm -f "$issue_json_file"
}

# 単一worktree内で開発サーバー起動〜claude起動〜終了時のdevサーバー停止までを行う
# run-issue-session.sh を起動するコマンド文字列を作る（PROMPT_FILEのパスのみを埋め込み、
# Issue本文・コメントなどの外部由来テキストはコマンド文字列に直接展開しない）。
build_claude_cmd() {
  local issue_number="$1"
  local worktree_dir="$2"
  local dev_port="$3"
  local prompt_file="$4"
  printf "cd %q && bash %q %q %q %q" "$worktree_dir" "$ROOT/scripts/run-issue-session.sh" "$issue_number" "$dev_port" "$prompt_file"
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

if [[ $# -eq 1 ]]; then
  n="$1"
  prepare_issue "$n"
  echo "#$n: 開発サーバーを自動起動し、Claude Codeセッションを起動します（このターミナルで実行）..."
  cd "$WORKTREE_DIR"
  exec bash "$ROOT/scripts/run-issue-session.sh" "$n" "$DEV_PORT" "$PROMPT_FILE"
fi

# 複数issue指定時は、それぞれ独立したセッションを同時に使うため新しいWindows Terminalタブで起動する。
WT_AVAILABLE=0
if command -v wt.exe >/dev/null 2>&1; then
  WT_AVAILABLE=1
fi
DISTRO="${WSL_DISTRO_NAME:-}"

for n in "$@"; do
  prepare_issue "$n"
  if [[ "$WT_AVAILABLE" -eq 1 && -n "$DISTRO" ]]; then
    echo "#$n: 新しいWindows Terminalタブで開発サーバーを自動起動し、セッションを起動します..."
    cmd="$(build_claude_cmd "$n" "$WORKTREE_DIR" "$DEV_PORT" "$PROMPT_FILE")"
    wt.exe -w 0 new-tab --title "$REPO_NAME #$n" -- wsl.exe -d "$DISTRO" -- bash -lc "$cmd"
  else
    echo "#$n: worktreeの準備ができました。以下を手動で実行してください:"
    echo "  cd \"$WORKTREE_DIR\" && bash \"$ROOT/scripts/run-issue-session.sh\" \"$n\" \"$DEV_PORT\" \"$PROMPT_FILE\""
  fi
done
