#!/usr/bin/env bash
# 複数リポジトリ横断の質問セッションのランチャー（#1454）。
#
# 使い方:
#   scripts/start-cross-repo-question.sh <owner> <repo> <issue番号>
#   scripts/start-cross-repo-question.sh --prepare-only <owner> <repo> <issue番号>
#
# 引数の `<owner>/<repo>` と `<issue番号>` は**質問Issueの置き場所**で、参照範囲ではない。
# 参照するのは「このホストが実行できると申告した全リポジトリ」（`local_repo_list_runnable`）で、
# それらの **`origin/develop` のスナップショット**（`scripts/lib/question-refs.sh`）を
# `--add-dir` で渡す。本体チェックアウトをそのまま渡すと、誰も更新しないため古いコードを
# 根拠に答えることになる（#1583）。
#
# 呼び出し経路:
#   issue-deckの画面「質問する」→「複数のリポジトリ（横断）」
#     → ジョブキュー（kind=CROSS_REPO_QUESTION）→ scripts/subpc-dispatch-poller.sh → このスクリプト
#
# ## 実装セッション（generic-start-issue.sh）との違い
#
#   worktree        質問のための作業用worktreeは作らない。**読み取り専用**なのでブランチも
#                   コミットも要らない（参照先のスナップショットだけはdetachedのworktree）
#   cwd             リポジトリごとに固定の空ディレクトリ
#                   （~/apps/issue-deck-worktrees/.questions/_session-<repo>）。
#                   どれか1つのリポジトリをcwdにすると、そのリポジトリのCLAUDE.mdだけが
#                   最初から効いてしまい、横断の質問なのに視点が偏る。**質問Issueごとには
#                   分けない**（毎回フォルダの信頼確認が出るため。#1529）
#   開発サーバー    起動しない
#   書き込みツール  `--disallowedTools`で封じる（プロンプトの指示だけに頼らない）
#   成果物          質問Issueへ投稿する回答コメント1件だけ
#
# セッション名は実装セッションと同じ `<リポジトリ名>-issue-<番号>` にする。**pollerの重複起動
# ガード・起動成否の差分検出・停止/終了/追加指示の突き合わせがすべてこの規約に依存している。**
#
# 環境変数:
#   ISSUE_DECK_QUESTION_BASE            質問セッションの作業ディレクトリの置き場
#   ISSUE_DECK_SHARED_CONTEXT_DIR       共有知識リポジトリ（既定は ~/apps/_docs）
#   ISSUE_DECK_CLAUDE_PERMISSION_MODE   claude の権限モード（既定は auto。#1205）
#   ISSUE_DECK_LAUNCHER_REEXEC          1なら同期コピーからの再実行を行わない（内部用・#1583）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT/scripts"

# 同期コピーから自分自身を実行し直すとき（#1583）にそのまま渡す。下の引数解析は
# `--prepare-only` を取り除いてしまうため、渡された形を先に控えておく。
ORIGINAL_ARGS=(${@+"$@"})

# 対応表の解決・検証は受け口・pollerと共有する（判定を二重に持たない）。
# shellcheck source=scripts/lib/local-repo-resolve.sh
source "$SCRIPT_DIR/lib/local-repo-resolve.sh"
# 個人設定・共有知識の同期の取り残しの警告（#1190）。
# shellcheck source=scripts/lib/personal-config-sync.sh
source "$SCRIPT_DIR/lib/personal-config-sync.sh"
# 起動スクリプト自身（issue-deckの本体の作業ツリー）が古いままの場合の警告（#1274・#1438）。
# shellcheck source=scripts/lib/launcher-scripts-sync.sh
source "$SCRIPT_DIR/lib/launcher-scripts-sync.sh"
# 参照先を`origin/develop`のスナップショットにする（#1583）。
# shellcheck source=scripts/lib/question-refs.sh
source "$SCRIPT_DIR/lib/question-refs.sh"

usage() {
  echo "Usage: scripts/start-cross-repo-question.sh [--prepare-only] <owner> <repo> <issue番号>" >&2
}

PREPARE_ONLY=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done
set -- ${POSITIONAL[@]+"${POSITIONAL[@]}"}

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

OWNER="$1"
REPO="$2"
ISSUE_NUMBER="$3"
FULL_NAME="$OWNER/$REPO"

# 引数はジョブキューのレスポンス経由で渡るため、呼び出し元で検証済みでも改めて検証する
# （多層防御。ここが最後にパス・シェル引数として使う場所）。
local_session_validate_target "$OWNER" "$REPO" "$ISSUE_NUMBER" || exit 1

for required_command in gh python3; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: $required_command コマンドが見つかりません。" >&2
    exit 1
  fi
done
if [[ "$PREPARE_ONLY" -eq 0 ]] && ! command -v claude >/dev/null 2>&1; then
  echo "Error: claude コマンドが見つかりません。" >&2
  exit 1
fi

resolve_launcher_scripts_dir "$ROOT"
# 本体が古いことは**再実行する前に**言う（再実行後はROOTが同期コピーの置き場になり、gitの
# 作業ツリーでないため何も出せない）。
warn_launcher_scripts_stale "$ROOT"

# **ランチャー自身も同期コピーから走らせる**（#1583）。
#
# pollerは本体の作業ツリーの`scripts/`を直接起動するため、#1438で新しくなるのは
# `run-issue-session.sh`と`prompts/`から先だけで、このスクリプト自身は本体のものが動いていた。
# その結果、developへ入れたランチャーの修正（#1529のcwd固定など）は**誰かが本体を`git pull`
# するまで効かない**。ここで一度だけ同期コピーへ移ることで、以降のランチャーの修正が
# マージした時点で効くようになる。
#
# **判断に迷ったら本体**という#1438の建て付けはそのまま使う。同期コピーを使うかどうかを
# 決めるのは`resolve_launcher_scripts_dir`で、未コミットの変更がある・fetchできない・展開に
# 失敗したといった場合は`LAUNCHER_SCRIPTS_SHA`が空になり、ここも素通りする。
if [[ -n "$LAUNCHER_SCRIPTS_SHA" && "${ISSUE_DECK_LAUNCHER_REEXEC:-0}" != "1" &&
  -f "$LAUNCHER_SCRIPTS_DIR/start-cross-repo-question.sh" ]]; then
  echo "情報: ランチャー自身も $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行し直します（#1583）。"
  # 再実行は1回だけ（同期コピー側のROOTはgitの作業ツリーではないため、そちらでは
  # `LAUNCHER_SCRIPTS_SHA`が空になり自然に止まるが、明示的な印も置く）。
  export ISSUE_DECK_LAUNCHER_REEXEC=1
  # セッションへの申告（どのコミットのスクリプトで動いているか）は引き継ぐ。
  export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA="$LAUNCHER_SCRIPTS_SHA"
  export ISSUE_DECK_LAUNCHER_ROOT="$ROOT"
  exec bash "$LAUNCHER_SCRIPTS_DIR/start-cross-repo-question.sh" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
fi

warn_personal_config_drift
# 同期コピーから再実行された側では`LAUNCHER_SCRIPTS_SHA`が空になるため、引き継いだ値を見る。
LAUNCHER_SCRIPTS_SHA="${LAUNCHER_SCRIPTS_SHA:-${ISSUE_DECK_LAUNCHER_SCRIPTS_SHA:-}}"
if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
  echo "情報: セッション側のスクリプトは $LAUNCHER_SYNC_REF の同期コピー（${LAUNCHER_SCRIPTS_SHA:0:7}）から実行します（#1438）。"
fi

# --- 参照するリポジトリ -------------------------------------------------------
# **申告と同じ関数を使う**（`local_repo_list_runnable`）。画面に出ている参照範囲の件数と、
# 実際に渡すディレクトリがずれないようにするため。1件も無ければ質問に答える材料が無いので、
# 起動せずに理由を出して止める（issue-deck側も`no_runnable_repositories`で断っている）。
REFERENCE_NAMES=()
REFERENCE_PATHS=()
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  if ! repo_path="$(local_repo_resolve_path "$name")"; then
    continue
  fi
  [[ -d "$repo_path" ]] || continue
  REFERENCE_NAMES+=("$name")
  REFERENCE_PATHS+=("$repo_path")
done < <(local_repo_list_runnable)

if [[ "${#REFERENCE_PATHS[@]}" -eq 0 ]]; then
  echo "Error: 参照できるリポジトリが1つもありません（$(local_repos_config_file)）。" >&2
  echo "  cloneの有無と対応表の記載を確認してください。" >&2
  exit 1
fi

# --- 参照先を origin/develop のスナップショットへ寄せる（#1583）--------------------------------
# **本体チェックアウトをそのまま渡さない。** 更新する仕組みが無いため古いコードを根拠に
# 答えることになる（実測で最大29コミット遅れ）。fetchは全リポジトリぶんを並列で行い、
# 用意できなかったリポジトリだけ本体チェックアウトへ落とす（理由は参照一覧に出す）。
echo "#$ISSUE_NUMBER: 参照するリポジトリを最新化しています（${#REFERENCE_PATHS[@]}件）..."
question_refs_fetch_all "${REFERENCE_PATHS[@]}"

REFERENCE_DIRS=()
REFERENCE_LABELS=()
SNAPSHOT_COUNT=0
for i in "${!REFERENCE_NAMES[@]}"; do
  question_ref_prepare "${REFERENCE_NAMES[$i]}" "${REFERENCE_PATHS[$i]}"
  REFERENCE_DIRS+=("$QUESTION_REF_DIR")
  REFERENCE_LABELS+=("$QUESTION_REF_LABEL")
  [[ "$QUESTION_REF_SNAPSHOT" -eq 1 ]] && SNAPSHOT_COUNT=$((SNAPSHOT_COUNT + 1))
done

echo "#$ISSUE_NUMBER: 参照するリポジトリ: ${#REFERENCE_DIRS[@]}件（スナップショット ${SNAPSHOT_COUNT}件・本体チェックアウト $(( ${#REFERENCE_DIRS[@]} - SNAPSHOT_COUNT ))件）"

# --- 作業ディレクトリ ---------------------------------------------------------
# **どのリポジトリでもない空のディレクトリをcwdにする。** 実装セッションのworktreeや
# リポジトリ本体をcwdにすると、そこだけが「主」になって横断の視点が偏るうえ、
# 他セッションが編集中の作業ツリーへ書き込む余地を残すことになる。
#
# **質問Issueごとには分けず、リポジトリごとの固定名にする**（#1529）。Claude Codeのフォルダの
# 信頼確認（`Is this a project you created or one you trust?`）はディレクトリ単位で
# `~/.claude.json`に記録されるため、質問のたびに新しいディレクトリを作ると毎回聞かれる。
# **信頼確認が出ている間はフックが1つも飛ばない**（#1465）ので、issue-deckへの報告も出ず、
# 端末を見ていないと止まっていることに気づけない。固定すれば人が1回答えるだけで済む。
# `~/.claude.json`を機械が書き換えないので「信頼確認そのものは自動化しない」という
# 取り決め（docs/multi-agent/session-notify.md）とも衝突しない。
#
# 粒度をリポジトリごとにしているのは、会話履歴とメモリ（`~/.claude/projects/<cwd>/`）が
# cwd単位で置かれるため。全質問で1つにすると`/resume`の一覧に無関係なリポジトリの質問まで
# 並ぶので、共有の範囲を同じリポジトリの質問に限る。
QUESTION_BASE="${ISSUE_DECK_QUESTION_BASE:-$HOME/apps/issue-deck-worktrees/.questions}"
SAFE_REPO="${REPO//[^A-Za-z0-9_-]/-}"
# 接頭辞`_session-`で、以前の質問ごとのディレクトリ（`<repo>-<番号>`）と名前がぶつからない。
SESSION_DIR="$QUESTION_BASE/_session-$SAFE_REPO"
PROMPT_DIR="$QUESTION_BASE/.prompts"
PROMPT_FILE="$PROMPT_DIR/$SAFE_REPO-$ISSUE_NUMBER.md"
mkdir -p "$SESSION_DIR" "$PROMPT_DIR"

# --- 質問Issue ---------------------------------------------------------------
echo "#$ISSUE_NUMBER: 質問Issueを取得しています（$FULL_NAME）..."
if ! ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$FULL_NAME" \
  --json number,title,body,comments 2>/dev/null)"; then
  echo "Error: Issue #$ISSUE_NUMBER（$FULL_NAME）を取得できませんでした。" >&2
  exit 1
fi

PROMPT_TEMPLATE="$LAUNCHER_SCRIPTS_DIR/prompts/cross-repo-question-agent.md"
if [[ ! -f "$PROMPT_TEMPLATE" ]]; then
  echo "Error: プロンプトのテンプレートがありません（$PROMPT_TEMPLATE）。" >&2
  exit 1
fi

# 参照リポジトリの一覧をプロンプトへ差し込む形（`- owner/repo … パス（鮮度）`）に整える。
# **鮮度を必ず添える**（#1583）。回答は「いまのdevelopがどうなっているか」として読まれるため、
# 何時点の何を読んだのかを回答へ書けるようにする。
REFERENCE_LIST=""
for i in "${!REFERENCE_NAMES[@]}"; do
  REFERENCE_LIST+="- \`${REFERENCE_NAMES[$i]}\` … \`${REFERENCE_DIRS[$i]}\`（${REFERENCE_LABELS[$i]}）"$'\n'
done

echo "#$ISSUE_NUMBER: 起動用プロンプトを生成しています..."
ISSUE_JSON_FILE="$(mktemp)"
printf '%s' "$ISSUE_JSON" >"$ISSUE_JSON_FILE"
python3 - "$ISSUE_JSON_FILE" "$PROMPT_TEMPLATE" "$FULL_NAME" "$SESSION_DIR" "$REFERENCE_LIST" \
  >"$PROMPT_FILE" <<'PY'
import json
import sys

(
    issue_json_path,
    template_path,
    repository,
    session_dir,
    reference_list,
) = sys.argv[1:6]

with open(issue_json_path, encoding="utf-8") as f:
    issue = json.load(f)
with open(template_path, encoding="utf-8") as f:
    template = f.read()

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

replacements = {
    "{{ISSUE_NUMBER}}": str(issue["number"]),
    "{{ISSUE_TITLE}}": issue["title"],
    "{{ISSUE_BODY}}": issue.get("body") or "(本文なし)",
    "{{ISSUE_COMMENTS}}": comment_text,
    "{{REPOSITORY}}": repository,
    "{{SESSION_DIR}}": session_dir,
    "{{REFERENCE_LIST}}": reference_list.rstrip("\n") or "(なし)",
    "{{REFERENCE_COUNT}}": str(len([l for l in reference_list.splitlines() if l.strip()])),
}
result = template
for placeholder, value in replacements.items():
    result = result.replace(placeholder, value)
sys.stdout.write(result)
PY
rm -f "$ISSUE_JSON_FILE"

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  echo "#$ISSUE_NUMBER: 準備が完了しました。"
  echo "  作業ディレクトリ: $SESSION_DIR"
  echo "  プロンプト: $PROMPT_FILE"
  echo "  参照先:"
  for i in "${!REFERENCE_NAMES[@]}"; do
    echo "    ${REFERENCE_NAMES[$i]} … ${REFERENCE_DIRS[$i]}（${REFERENCE_LABELS[$i]}）"
  done
  exit 0
fi

# --- セッションの起動 ---------------------------------------------------------
SESSION_NAME="$SAFE_REPO-issue-$ISSUE_NUMBER"

# tmuxのセッションはtmuxサーバー側の環境を引き継ぐため、このプロセスのexportが届くとは限らない。
# 値は%qでクォートして埋める。
build_env_prefix() {
  local var value dir prefix="" dirs=""
  # 開発サーバーは起動しない（読み取り専用の質問セッションで、画面を見る用事が無い）
  prefix+="export ISSUE_DECK_DEV_SERVER=0; "
  prefix+="export ISSUE_DECK_WORKTREE_BASE=$(printf '%q' "$QUESTION_BASE"); "
  # cwdがgitリポジトリでないため、run-issue-session.sh は remote.origin.url から
  # リポジトリ名を取れない（#1454）。セッション名とセッション報告のために渡す
  prefix+="export ISSUE_DECK_REPO_SLUG=$(printf '%q' "$FULL_NAME"); "
  # 回収の条件を実装セッションと分ける印（#1454）。worktreeを持たないため、
  # 「worktreeがcleanでpush済み」の判定を当てると永久に残る
  prefix+="export ISSUE_DECK_SESSION_KIND=question; "
  # **前回の会話を引き継がない**（#1648）。run-issue-session.sh は cwd に会話履歴があれば
  # `--continue` を付ける（#1541）が、質問セッションの cwd は**質問Issueごとではなく
  # リポジトリごと**に固定されている（#1529）ため、そこに残っている会話は同じ質問のものとは
  # 限らない。放置の猶予でセッションが畳まれるようになった以上（#1648）、引き継ぐと
  # 「別の質問の続き」として始まる事故が起きる。畳まれた後の続きは新しい質問として聞き直す。
  prefix+="export ISSUE_DECK_CLAUDE_RESUME=0; "
  # **書き込み系のツールを機械的に封じる。** `gh issue comment`で回答するためBashは残す
  prefix+="export ISSUE_DECK_DISALLOWED_TOOLS=$(printf '%q' "Edit,Write,NotebookEdit"); "
  for dir in "${REFERENCE_DIRS[@]}"; do
    dirs+="$dir"$'\n'
  done
  prefix+="export ISSUE_DECK_EXTRA_DIRS=$(printf '%q' "$dirs"); "
  for var in ISSUE_DECK_SHARED_CONTEXT_DIR ISSUE_DECK_CLAUDE_PERMISSION_MODE \
    ISSUE_DECK_SESSION_REAPABLE ISSUE_DECK_SESSION_STATE_DIR; do
    value="${!var:-}"
    [[ -n "$value" ]] || continue
    prefix+="export $var=$(printf '%q' "$value"); "
  done
  if [[ -n "$LAUNCHER_SCRIPTS_SHA" ]]; then
    prefix+="export ISSUE_DECK_LAUNCHER_SCRIPTS_SHA=$(printf '%q' "$LAUNCHER_SCRIPTS_SHA"); "
    # 同期コピーから再実行された側（#1583）の `$ROOT` は同期コピーの置き場になる。
    # セッションが「どのチェックアウトが古いのか」を出せるよう、本体のパスを引き継ぐ。
    prefix+="export ISSUE_DECK_LAUNCHER_ROOT=$(printf '%q' "${ISSUE_DECK_LAUNCHER_ROOT:-$ROOT}"); "
  fi
  printf '%s' "$prefix"
}

# 開発サーバーのポートは使わないが、run-issue-session.sh の引数は3つ固定なので0を渡す
# （`ISSUE_DECK_DEV_SERVER=0`のため参照されない）。
SESSION_CMD="$(printf "%scd %q && bash %q %q %q %q" "$(build_env_prefix)" "$SESSION_DIR" \
  "$LAUNCHER_SCRIPTS_DIR/run-issue-session.sh" "$ISSUE_NUMBER" "0" "$PROMPT_FILE")"

if ! command -v tmux >/dev/null 2>&1; then
  echo "警告: tmux が見つからないため、このターミナルで起動します（切断するとセッションも終了します）。" >&2
  cd "$SESSION_DIR"
  exec bash -lc "$SESSION_CMD"
fi

# 同名のセッションが動いていれば作らない（実装セッションと同じ扱い）。`remain-on-exit`で
# 残った「死んだペインだけのセッション」は前回の終了の痕跡なので、最後の出力を見せてから畳む。
if tmux has-session -t "=$SESSION_NAME" 2>/dev/null; then
  ALIVE_PANES="$(tmux list-panes -s -t "=$SESSION_NAME" -F '#{pane_dead}' 2>/dev/null | grep -cv '^1$' || true)"
  if [[ "${ALIVE_PANES:-0}" -eq 0 ]]; then
    echo "#$ISSUE_NUMBER: 前回のtmuxセッション「$SESSION_NAME」は終了したまま残っていました。最後の出力:"
    tmux capture-pane -p -t "$SESSION_NAME:" 2>/dev/null | grep -v '^$' | tail -n 15 | sed 's/^/    /' || true
    tmux kill-session -t "=$SESSION_NAME" >/dev/null 2>&1 || true
  else
    echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」は既に動いています。新しくは起動しません。"
    exit 0
  fi
fi

echo "#$ISSUE_NUMBER: tmuxセッション「$SESSION_NAME」で横断質問セッションを起動します..."
if ! tmux new-session -d -s "$SESSION_NAME" -c "$SESSION_DIR" "bash -lc $(printf '%q' "$SESSION_CMD")"; then
  echo "Error: tmuxセッション「$SESSION_NAME」の起動に失敗しました。" >&2
  exit 1
fi

# 異常終了時にペインを残す（既定ではコマンドの終了と同時にセッションごと消え、エラーが残らない）。
tmux set-option -t "$SESSION_NAME:" -w remain-on-exit failed >/dev/null 2>&1 ||
  tmux set-option -t "$SESSION_NAME:" -w remain-on-exit on >/dev/null 2>&1 || true

echo
echo "起動したセッションはこのターミナルを閉じても（SSHが切れても）動き続けます。"
if [[ -n "${TMUX:-}" ]]; then
  echo "  tmux switch-client -t $SESSION_NAME"
elif [[ -t 0 && -t 1 ]]; then
  echo "アタッチします（切り離すには Ctrl-b d）..."
  exec tmux attach-session -t "=$SESSION_NAME"
else
  echo "  tmux attach -t $SESSION_NAME"
fi
