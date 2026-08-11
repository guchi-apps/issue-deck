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
#
# --prepare-only はworktree・ブランチ・起動用プロンプトの準備だけを行い、開発サーバーも
# Claude Codeセッションも起動せずに終了する。VSCodeのClaude Codeタブから `/issue <番号>`
# で呼ぶ用途（既にセッションの中にいるので、さらにclaudeを起動しても意味がない。#1049）。
#
# worktreeが既にある場合は作り直さず再利用する。一度閉じたセッションに戻るための経路であり、
# ワンクリック起動（画面の「ローカルで開始」）を2回目以降に押しても使える（#1076）。
#
# 起動時にIssueへ `11.local`（無人実行との二重起動を防ぐ停止フラグ。#1097）と進捗ラベル
# （`01.planning`/`02.wip`。#1096）を付ける。どの起動経路（ターミナル・画面のボタン・
# `/issue`）もこのスクリプトを通るため、ここに置けば付け忘れが起きない。
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
WORKTREE_BASE="${ISSUE_DECK_WORKTREE_BASE:-$HOME/apps/issue-deck-worktrees}"
PROMPT_TEMPLATE="$ROOT/scripts/prompts/implementation-agent.md"
PROMPT_DIR="$WORKTREE_BASE/.prompts"

PREPARE_ONLY=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

# ワンクリック起動（scripts/start-local-session.sh）から呼ばれた場合に立つ。LANアクセス設定は
# Windowsの管理者権限を要求し、wt.exeで開いたタブではUACを承認しても待ちから戻らずタブが
# 固まるため、この経路では行わない（#1076）。
SKIP_LAN_SETUP="${ISSUE_DECK_SKIP_LAN_SETUP:-0}"

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/start-issue.sh [--prepare-only] <issue番号> [issue番号...]" >&2
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

# 起動時にIssueへ付けるラベルを決めて付与する（#1096・#1097）。
#
# - `11.local`: ローカルセッションで対応中であることを示す停止フラグ。付いている間は
#   無人実行（`claude-issue-dispatch.yml`）がこのIssueに手を出さない（#1097）
# - 進捗ラベル: `21.plan-required` が付いていれば `01.planning`、無ければ `02.wip`（#1096）。
#   ラベルを付ければWebhook経由でGitHub ProjectsのStatusも追随するため、Statusの報告は行わない
#
# **既に進捗ラベルが付いている場合は進捗ラベルに触らない。** 再開（#1076）で2回目以降に
# 起動したときに、`03.d:marge`まで進んだIssueを`02.wip`へ巻き戻さないため。
#
# ラベル付与に失敗しても起動は止めない（起動できないより、記録が遅れる方が軽い。画面の
# 「ローカルで開始」ボタンも`11.local`について同じ方針を取っている）。
apply_start_labels() {
  local n="$1"
  # 既に付いているラベル名（1行1つ）。判定に使うだけなのでIssue取得のJSONから読み、
  # 追加のAPI呼び出しはしない。
  local existing="$2"
  local add_labels=()

  if ! printf '%s\n' "$existing" | grep -Fxq "11.local"; then
    add_labels+=("11.local")
  fi

  local current_progress="" p
  for p in "01.planning" "02.wip" "03.d:marge" "05.develop" "07.m:marge" "09.main"; do
    if printf '%s\n' "$existing" | grep -Fxq "$p"; then
      current_progress="$p"
      break
    fi
  done
  if [[ -z "$current_progress" ]]; then
    if printf '%s\n' "$existing" | grep -Fxq "21.plan-required"; then
      add_labels+=("01.planning")
    else
      add_labels+=("02.wip")
    fi
  fi

  if [[ ${#add_labels[@]} -eq 0 ]]; then
    echo "#$n: ラベルは付与済みです（進捗: ${current_progress:-なし}）。"
    return 0
  fi

  local gh_args=() l
  for l in "${add_labels[@]}"; do
    gh_args+=(--add-label "$l")
  done
  if gh issue edit "$n" --repo guchi-apps/issue-deck "${gh_args[@]}" >/dev/null; then
    echo "#$n: ラベルを付与しました（$(IFS=, ; echo "${add_labels[*]}")）。"
  else
    echo "#$n: 警告: ラベル（$(IFS=, ; echo "${add_labels[*]}")）の付与に失敗しました。手動で付けてください。" >&2
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
    dirty_count="$(git -C "$WORKTREE_DIR" status --porcelain | wc -l)"
    if [[ "$dirty_count" -gt 0 ]]; then
      echo "#$n: 未コミットの変更が $dirty_count 件あります。前回の続きから作業してください。"
    fi
  fi

  echo "#$n: Issue内容を取得しています..."
  local issue_json
  if ! issue_json="$(gh issue view "$n" --repo guchi-apps/issue-deck --json number,title,body,labels,comments)"; then
    echo "Error: issue #$n の取得に失敗しました。" >&2
    exit 1
  fi

  # ラベルの付与は、worktree作成やpnpm installより先に行う。二重起動の停止フラグ
  # （`11.local`）は早く立つほど効くうえ、以降の重い処理が失敗しても着手した記録は残る。
  local issue_labels
  if issue_labels="$(printf '%s' "$issue_json" | python3 -c 'import json, sys; print("\n".join(l["name"] for l in json.load(sys.stdin).get("labels") or []))')"; then
    apply_start_labels "$n" "$issue_labels"
  else
    # 解析できないまま付与すると、既に進んでいる進捗ラベルを巻き戻しかねないのでスキップする。
    echo "#$n: 警告: ラベル一覧を解析できなかったため、起動時のラベル付与をスキップします。" >&2
  fi

  if [[ "$reuse_worktree" -eq 0 ]]; then
    echo "#$n: develop を最新化しています..."
    git -C "$ROOT" fetch origin develop

    echo "#$n: worktree・ブランチ issue-$n を作成しています..."
    if ! git -C "$ROOT" worktree add "$WORKTREE_DIR" -b "issue-$n" origin/develop; then
      echo "Error: worktree/ブランチの作成に失敗しました（ブランチ issue-$n が既に存在する可能性があります）。" >&2
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
    wt.exe -w 0 new-tab --title "issue-$n" -- wsl.exe -d "$DISTRO" -- bash -lc "$cmd"
  else
    echo "#$n: worktreeの準備ができました。以下を手動で実行してください:"
    echo "  cd \"$WORKTREE_DIR\" && bash \"$ROOT/scripts/run-issue-session.sh\" \"$n\" \"$DEV_PORT\" \"$PROMPT_FILE\""
  fi
done
