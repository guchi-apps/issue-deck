#!/usr/bin/env bash
# 実装セッションの状態をSignalyへ通知するフックスクリプト（#1219）。
#
# Claude Codeのフック（`Notification`・`Stop`）から呼ばれ、フックのstdinに来るJSONを読んで
# 通知を1件投げる。設定は run-issue-session.sh が生成する settings JSON 側にあり、
# このスクリプトを直接叩くのは検証のときだけ。
#
# 使い方（フックのcommandとして）:
#   scripts/session-notify.sh <Issue番号> <リポジトリ名> [owner/repo]   （JSONはstdinから）
#
# 第3引数の `owner/repo` はIssueのURLを組み立てるためだけに使う。省略するとリンクが載らない。
#
# **セッションを止めないことが最優先。** 通知経路の障害で実装が止まるのは本末転倒なので、
# 何が起きても最後は exit 0 で返す。フックが非0で終了してもClaude Codeは
# 「Failed with non-blocking status code」と表示して続行するが（実測）、それでも
# セッションのログに毎回エラーが出ると本来見たいものが読めなくなる。
# なお exit 2 はフックの規約でブロッキング扱いになるため絶対に返さない。
#
# 設定は `~/.config/issue-deck/notify.env`（chmod 600）から読む。書式は
# deploy/subpc/notify.env.example を参照。設定していない環境では黙って何もしない
# （通知を設定していないPCでもセッションの起動を妨げないため）。
#
# 送信先の変数は `SESSION_NOTIFY_WEBHOOK_URL`。旧名の `SIGNALY_WEBHOOK_URL` も互換のため
# 読むが、新規に設定するときは新しい名前を使う（#1231）。
#
# 検証用の環境変数:
#   SESSION_NOTIFY_DRY_RUN=1   送信せず、送るはずのpayloadを標準出力へ出す

set -uo pipefail

# 引数が足りなくても落とさない。フックのcommandを書き間違えたときに、
# セッションのたびにエラーが出るだけで済ませる。
ISSUE_NUMBER="${1:-}"
REPO_NAME="${2:-}"
REPO_SLUG="${3:-}"

# stdinのJSON。端末から直接叩かれたときにcatで待ち続けないよう、ttyなら何もせずに終わる。
if [[ -t 0 ]]; then
  echo "session-notify: JSONをstdinから渡してください（フックから呼ばれるスクリプトです）" >&2
  exit 0
fi
HOOK_JSON="$(cat || true)"
if [[ -z "$HOOK_JSON" ]]; then
  exit 0
fi

NOTIFY_ENV_FILE="${ISSUE_DECK_NOTIFY_ENV:-$HOME/.config/issue-deck/notify.env}"
if [[ -f "$NOTIFY_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$NOTIFY_ENV_FILE" || true
  set +a
fi

# 送信先はセッション通知専用のチャンネル（1Passwordの session-webhook-url）で、
# CI/デプロイ通知の SIGNALY_WEBHOOK_URL とは別物（#1231）。
# 旧名のまま設定されている既存インストールを壊さないよう、未設定のときだけ旧名へ落とす。
WEBHOOK_URL="${SESSION_NOTIFY_WEBHOOK_URL:-${SIGNALY_WEBHOOK_URL:-}}"
if [[ -z "$WEBHOOK_URL" ]]; then
  # 未設定は異常ではない。通知を使わない環境ではこれが正常な経路。
  exit 0
fi

# ---------------------------------------------------------------------------
# 送るかどうかの判定とpayloadの組み立て
#
# 判定・組み立て・シェルへ返す値の生成をすべてpython3側に寄せる。フックのJSONを
# シェルでパースする（grep -o 等）と、値に引用符や改行が入った時点で壊れるため。
# 標準出力の1行目を「送るか（send/skip）」、2行目以降をpayloadとして返す。
# ---------------------------------------------------------------------------
export HOOK_JSON
export NOTIFY_ISSUE_NUMBER="$ISSUE_NUMBER"
export NOTIFY_REPO_NAME="$REPO_NAME"
export NOTIFY_REPO_SLUG="$REPO_SLUG"
export NOTIFY_HOST_NAME="${DISPATCH_HOST_NAME:-$(hostname -s 2>/dev/null || echo unknown)}"
export NOTIFY_CLAUDE_SESSIONS_DIR="$HOME/.claude/sessions"

# tmuxのセッション名。`tmux attach -t <名前>` でそのまま繋げるよう、通知に載せる。
# tmuxの外で起動した場合は空になる。
NOTIFY_TMUX_SESSION=""
if [[ -n "${TMUX:-}" ]]; then
  NOTIFY_TMUX_SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi
export NOTIFY_TMUX_SESSION

result="$(python3 - <<'PY' 2>/dev/null || true
import glob
import json
import os
import sys

try:
    hook = json.loads(os.environ.get("HOOK_JSON", ""))
except Exception:
    sys.exit(0)
if not isinstance(hook, dict):
    sys.exit(0)

event = hook.get("hook_event_name", "")
notification_type = hook.get("notification_type", "")

# 飛ばすのは「本当に人の判断が要るもの」と「完了」の2つだけ（#1219）。
#
# - Notification / permission_prompt: 承認プロンプト・AskUserQuestionの質問。
#   `--permission-mode auto`（#1205）でもAskUserQuestionでは発火する。
# - Stop: 応答の終了。無人で回すセッションでは実質「作業完了」。
#
# **Notification / idle_prompt は捨てる。** 応答終了から60秒アイドルすると発火するので、
# 直前のStopと必ず二重になる。通知が多すぎると意味を失う。
if event == "Stop":
    emoji = "✅"
    color = "#57f287"
    label = "応答終了"
elif event == "Notification" and notification_type == "permission_prompt":
    emoji = "🙋"
    color = "#faa61a"
    label = "入力待ち"
else:
    print("skip")
    sys.exit(0)

issue_number = os.environ.get("NOTIFY_ISSUE_NUMBER", "")
repo_name = os.environ.get("NOTIFY_REPO_NAME", "")
host_name = os.environ.get("NOTIFY_HOST_NAME", "")
tmux_session = os.environ.get("NOTIFY_TMUX_SESSION", "")

# remote-controlのURL（best-effort）。
# `~/.claude/sessions/<pid>.json` に sessionId と bridgeSessionId の対応がある。
# **非公開の内部ファイルなので、読めなくても・形が変わっても通知自体は落とさない。**
# `--remote-control` を付けずに起動した場合は bridgeSessionId が無く、URLも載らない。
remote_url = ""
session_id = hook.get("session_id", "")
if session_id:
    try:
        for path in glob.glob(os.path.join(os.environ.get("NOTIFY_CLAUDE_SESSIONS_DIR", ""), "*.json")):
            try:
                with open(path, encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                continue
            if meta.get("sessionId") != session_id:
                continue
            bridge = meta.get("bridgeSessionId")
            if bridge:
                remote_url = f"https://claude.ai/code/{bridge}"
            break
    except Exception:
        remote_url = ""

title_parts = [emoji]
if repo_name and issue_number:
    title_parts.append(f"[{repo_name} #{issue_number}]")
elif repo_name:
    title_parts.append(f"[{repo_name}]")
title_parts.append(label)
if host_name:
    title_parts.append(f"({host_name})")
title = " ".join(title_parts)

# **応答テキスト（hook の last_assistant_message）は載せない。**
# Issue本文の引用・ファイルの中身・コマンドの出力が混ざりうるものを、外部サービスである
# Signalyへ出す経路を最初から作らない。中身はremote-controlのURLから見る。
fields = []
if repo_name:
    fields.append({"name": "Repository", "value": f"`{repo_name}`", "inline": True})
if issue_number:
    fields.append({"name": "Issue", "value": f"#{issue_number}", "inline": True})
if host_name:
    fields.append({"name": "Host", "value": host_name, "inline": True})
fields.append({"name": "Event", "value": label, "inline": True})
if tmux_session:
    fields.append({"name": "tmux", "value": f"`tmux attach -t {tmux_session}`", "inline": False})

links = []
repo_slug = os.environ.get("NOTIFY_REPO_SLUG", "").strip("/")
if repo_slug and issue_number:
    links.append(f"[Issue #{issue_number}](https://github.com/{repo_slug}/issues/{issue_number})")
if remote_url:
    links.append(f"[セッションを開く（remote-control）]({remote_url})")
if links:
    fields.append({"name": "Links", "value": " · ".join(links), "inline": False})

print("send")
print(json.dumps({"title": title, "color": color, "fields": fields}))
PY
)"

# python3が無い・落ちた場合は result が空になる。そのときも黙って終わる。
if [[ -z "$result" ]]; then
  exit 0
fi

decision="$(printf '%s' "$result" | head -1)"
if [[ "$decision" != "send" ]]; then
  exit 0
fi
payload="$(printf '%s' "$result" | tail -n +2)"
if [[ -z "$payload" ]]; then
  exit 0
fi

if [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

# 応答が返らないwebhookで実装セッションを待たせないため、必ずタイムアウトを掛ける。
if ! curl -fsS --max-time 10 \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "$WEBHOOK_URL" >/dev/null 2>&1; then
  # 失敗理由をURLごと出すとwebhookのシークレットがセッションのログに残る。1行に留める。
  echo "session-notify: Signalyへの通知に失敗しました（実装は続行します）" >&2
fi

exit 0
