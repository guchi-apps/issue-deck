#!/usr/bin/env bash
# `.claude/settings.json`（リポジトリに入れるプロジェクト設定）から呼ぶための、
# `session-notify.sh` の引数無しの入口（#1456）。
#
# ## なぜworktree側にも同じフックを置くのか
#
# フックの設定を書くのは `run-issue-session.sh` で、**それ自体が本体リポジトリの作業ツリー
# （`~/apps/issue-deck/scripts/`）から実行される**（#1274）。worktreeだけが毎回
# `origin/develop` から作り直されるので、developへ入れた修正は**人が`git pull`するまで
# 反映されない**。#1445はこれを「セッション側のスクリプトは`origin/develop`の同期コピーから
# 走らせる」ことで解こうとしたが、**その判断をするコード（`lib/launcher-scripts-sync.sh`）
# 自身が古い作業ツリーにある**ため、1度pullするまでは効かない。
#
# 実際にこれで詰まった。`00.check-user`を承認と同時に外す仕組み（#1357・#1417・#1438）を
# developへ入れた後も、作業ツリーが古いホストでは`PostToolUse`のフック設定がそもそも生成
# されず、承認しても応答終了（`Stop`）まで外れなかった（#1438 → #1446 → #1456）。
#
# **`.claude/settings.json`はworktreeの中にあり、worktreeは常に`origin/develop`から作られる。**
# つまりここに置いたフックだけは、本体の作業ツリーの新しさに一切依存しない。**起動スクリプトが
# 古いままでも、developへマージした時点で次のセッションから効く。**
#
# ## 置くのは`PostToolUse`だけ
#
# `Notification`・`Stop`・`PreToolUse`は古い作業ツリーでも生成されるので、ここに足すと
# **同じ入力待ちがSignalyへ二重に飛ぶ**。`PostToolUse`だけは、
#
# - 古いホストでは生成されない＝二重にならない
# - 新しいホストでは二重になるが、`session-notify.sh`が「状態ファイルの最後のイベントが
#   `permission_prompt`のとき」以外を即座に捨てるため、実際に報告が飛ぶのは入力待ち1回につき
#   最大1回。二重に走っても`/activity`が1回余計に飛ぶだけで、ラベルの除去は冪等
#   （`removeIssueLabel`は404を成功として扱う）
#
# という性質があるため、ここだけを持たせる。
#
# ## ランチャーが起こしたセッション以外では何もしない
#
# プロジェクト設定はこのリポジトリで`claude`を起動したすべてのセッションに掛かる。人が手元で
# 開いた対話セッションやGitHub Actions上の無人実行まで報告を飛ばさないよう、
# **tmuxのセッション名がランチャーの規約（`<リポジトリ名>-issue-<番号>`）に一致し、かつ
# worktreeが`issue-<番号>`ブランチにあるときだけ**先へ進む。
#
# 判定はすべてここで終わらせ、`session-notify.sh`側の判定（どのイベントを扱うか）は触らない。
# ここが持つのは「誰のセッションか」だけで、「何を送るか」は向こうの1箇所に集める。
#
# **セッションを止めないことが最優先**（`session-notify.sh`と同じ約束）。何が起きても`exit 0`。

set -uo pipefail

# フックはtmuxの中で走るセッションからしか来ない。**最初に落とすのがいちばん安い。**
# `PostToolUse`はツールの実行ごとに飛ぶため、ここから先へ進む条件は早く狭める。
[[ -n "${TMUX:-}" ]] || exit 0

SESSION_NAME="$(tmux display-message -p '#S' 2>/dev/null || true)"
[[ "$SESSION_NAME" =~ ^([A-Za-z0-9_-]+)-issue-([0-9]+)$ ]] || exit 0
TMUX_REPO_NAME="${BASH_REMATCH[1]}"
ISSUE_NUMBER="${BASH_REMATCH[2]}"

# フックのコマンドで`$CLAUDE_PROJECT_DIR`が展開される（実測）。展開されない版へ備えて、
# このスクリプト自身の置き場所からも引けるようにしておく。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
[[ -n "$PROJECT_DIR" ]] || PROJECT_DIR="${SCRIPT_DIR%/scripts}"
[[ -n "$PROJECT_DIR" ]] || exit 0

# worktreeが担当Issueのブランチにあること。tmuxのセッション名だけを見ると、ランチャーの
# セッションに人が別のディレクトリで`claude`を開いた場合まで拾ってしまう。
BRANCH="$(git -C "$PROJECT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ "$BRANCH" == "issue-$ISSUE_NUMBER" ]] || exit 0

# `owner/repo`。IssueのURLを組み立てるためと、issue-deckへの報告の宛先に使う。
# **末尾の2要素だけを見る。** リモートURLは`https://`・`git@host:`・認証情報入りと形が揃わず、
# 前半を解釈しようとすると形ごとに分岐が増える。区切りは`/`と`:`のどちらもありうる。
REMOTE_URL="$(git -C "$PROJECT_DIR" config --get remote.origin.url 2>/dev/null || true)"
[[ -n "$REMOTE_URL" ]] || exit 0
REPO_PATH="${REMOTE_URL%.git}"
REPO_PATH="${REPO_PATH%/}"
REPO_NAME="${REPO_PATH##*/}"
REPO_OWNER="${REPO_PATH%/*}"
REPO_OWNER="${REPO_OWNER##*[:/]}"
REPO_SLUG="$REPO_OWNER/$REPO_NAME"
[[ "$REPO_SLUG" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || exit 0

# tmuxのセッション名はランチャーが`[^A-Za-z0-9_-]`を`-`へ潰して作る（`start-issue.sh`の
# `tmux_session_name`）。同じ潰し方をしたリポジトリ名と一致しないなら、別のリポジトリの
# セッションの中でこのworktreeを開いている。
[[ "${REPO_NAME//[^A-Za-z0-9_-]/-}" == "$TMUX_REPO_NAME" ]] || exit 0

NOTIFY_SCRIPT="$SCRIPT_DIR/session-notify.sh"
[[ -x "$NOTIFY_SCRIPT" ]] || exit 0

# stdin（フックのJSON）はそのまま引き継ぐ。
exec "$NOTIFY_SCRIPT" "$ISSUE_NUMBER" "$REPO_NAME" "$REPO_SLUG"
