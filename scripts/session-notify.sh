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
#
# **未設定でもここでは終わらない**（#1256）。webhookの設定はSignalyへ送るかどうかを決めるだけで、
# セッションの状態をホストへ記録する処理（回収の判定材料）はそれとは独立している。
# 通知を設定していないホストでもセッションが畳まれるようにするため、判定は送信の直前まで下げた。
WEBHOOK_URL="${SESSION_NOTIFY_WEBHOOK_URL:-${SIGNALY_WEBHOOK_URL:-}}"

# セッションの状態ファイル（#1256）。読み書きの作法は回収スクリプトと共有する。
# **無くても通知は続ける**（このスクリプトはセッションを止めないことが最優先）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/session-state.sh" ]]; then
  # shellcheck source=scripts/lib/session-state.sh
  source "$SCRIPT_DIR/lib/session-state.sh" || true
fi

# ---------------------------------------------------------------------------
# 送るかどうかの判定とpayloadの組み立て
#
# 判定・組み立て・シェルへ返す値の生成をすべてpython3側に寄せる。フックのJSONを
# シェルでパースする（grep -o 等）と、値に引用符や改行が入った時点で壊れるため。
# 標準出力の1行目を「送るか（`send <イベント名> [remote-controlのURL]` / `skip`）」、
# 2行目以降をpayloadとして返す。イベント名を返すのはシェル側がセッションの状態として記録する
# ため（#1256）、URLを返すのはissue-deckの画面へ渡すため（#1264）。
# ---------------------------------------------------------------------------
export HOOK_JSON
export NOTIFY_ISSUE_NUMBER="$ISSUE_NUMBER"
export NOTIFY_REPO_NAME="$REPO_NAME"
export NOTIFY_REPO_SLUG="$REPO_SLUG"
export NOTIFY_HOST_NAME="${DISPATCH_HOST_NAME:-$(hostname -s 2>/dev/null || echo unknown)}"
export NOTIFY_CLAUDE_SESSIONS_DIR="$HOME/.claude/sessions"
# tailnetへ公開した開発サーバー（#1265）。run-issue-session.shがexportしている。
# 入力待ちの通知に載せると、気づいた側がその場で画面を開ける
export NOTIFY_PREVIEW_URL="${ISSUE_DECK_PREVIEW_URL:-}"

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
#
# `state_event` はシェル側が状態ファイルへ記録する値（#1256）。回収の判定はこの2値だけを見て
# 「人の入力待ちか、応答が終わっているか」を決めるため、表示用のラベルとは別に返す。
#
# `activity` はissue-deckの画面へ渡す値（#1264）。状態ファイル用の`state_event`と別に持つのは、
# 片方がホスト内の回収判定、もう片方が画面表示という別々の用途のため。
if event == "Stop":
    emoji = "✅"
    color = "#57f287"
    label = "応答終了"
    state_event = "Stop"
    activity = "responded"
elif event == "Notification" and notification_type == "permission_prompt":
    emoji = "🙋"
    color = "#faa61a"
    label = "入力待ち"
    state_event = "permission_prompt"
    activity = "waiting_input"
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

def signaly_link(text, url):
    """Signalyのfields値で「リンクとして表示される」書式を作る（#1247）。

    Signalyがfieldsの値でリンクにできるのは `[text](url)` のマスクドリンク記法だけで、
    生URLを置いても自動ではリンクにならない（Signalyの`docs/webhook.md`・
    `frontend/app.js`の`renderFieldValue`）。

    ただし`renderFieldValue`は `[text](url)` を
    `<a href="..." target="_blank" rel="noopener noreferrer">` へ置換した**あとで**
    `_..._` を `<em>` へ変換するため、生成後のHTMLに残る `_blank` のアンダースコアと
    URL中のアンダースコアが対になり、hrefとtarget属性ごと壊れる（#1234で観測した
    `</em>`の混入はこれ）。つまり1つの値に含まれるアンダースコアが2個以上あると壊れる。

    URL中の `_` を `%5F` にしておけば値に残るアンダースコアは `_blank` の1個だけになり、
    対にならないので壊れない。`%5F` は `_` のパーセントエンコードなので、URLとしての
    指す先は変わらない。
    """
    return f"[{text}]({url.replace('_', '%5F')})"


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
#
# **リンクは1つのフィールドに1つだけ入れる。** マスクドリンク1つにつき `target="_blank"` 由来の
# アンダースコアが1個増えるため、同じ値に2つ並べると `_` が対になって両方壊れる
# （`signaly_link`のコメント参照）。旧「Links」フィールドはIssueリンクとセッションURLを
# `·`で連結していて、これに該当していた（#1247）。
fields = []
repo_slug = os.environ.get("NOTIFY_REPO_SLUG", "").strip("/")
if repo_name:
    fields.append({"name": "Repository", "value": f"`{repo_name}`", "inline": True})
if issue_number:
    issue_value = f"#{issue_number}"
    if repo_slug:
        issue_value = signaly_link(issue_value, f"https://github.com/{repo_slug}/issues/{issue_number}")
    fields.append({"name": "Issue", "value": issue_value, "inline": True})
if host_name:
    fields.append({"name": "Host", "value": host_name, "inline": True})
fields.append({"name": "Event", "value": label, "inline": True})
if tmux_session:
    fields.append({"name": "tmux", "value": f"`tmux attach -t {tmux_session}`", "inline": False})
preview_url = os.environ.get("NOTIFY_PREVIEW_URL", "")
if preview_url:
    # 1フィールド1リンクを守る（`signaly_link`のコメント参照）
    fields.append(
        {"name": "開発環境", "value": signaly_link("画面を開く", preview_url), "inline": False}
    )

if remote_url:
    fields.append({
        "name": "Remote Control",
        "value": signaly_link("セッションを開く", remote_url),
        "inline": False,
    })
    # 生URLも別フィールドで残す。**スマホのプッシュ通知の本文はSignaly側がMarkdownを
    # 除去する**（`backend/push.py`の`_plain_text`）ので、マスクドリンクだけだと
    # プッシュ通知には表示名しか出ずURLが消える。手でコピーする経路を残しておく。
    # 単独の値なら含まれるアンダースコアは1個だけなので、`<em>`化で壊れない。
    fields.append({"name": "Remote Control URL", "value": remote_url, "inline": False})

print("send", state_event, activity, remote_url or "-")
print(json.dumps({"title": title, "color": color, "fields": fields}))
PY
)"

# python3が無い・落ちた場合は result が空になる。そのときも黙って終わる。
if [[ -z "$result" ]]; then
  exit 0
fi

decision_line="$(printf '%s' "$result" | head -1)"
# 形式: `send <状態イベント> <activity> <remote-controlのURL または "-">`
read -r decision STATE_EVENT ACTIVITY REMOTE_URL <<<"$decision_line"
if [[ "$decision" != "send" ]]; then
  exit 0
fi
[[ "$REMOTE_URL" == "-" ]] && REMOTE_URL=""

# セッションの状態を記録する（#1256）。**送信より先に行う。**
# webhookが未設定でも・Signalyが落ちていても、回収の判定材料はホストに残る必要がある。
# tmuxの外で起動したセッション（セッション名が空）は回収の対象外なので記録しない。
if [[ -n "$STATE_EVENT" && -n "$NOTIFY_TMUX_SESSION" ]] &&
  declare -F session_state_record_event >/dev/null 2>&1; then
  session_state_record_event "$NOTIFY_TMUX_SESSION" "$STATE_EVENT" ||
    echo "session-notify: セッションの状態を記録できませんでした（実装は続行します）" >&2
fi

# issue-deckの画面へも同じ様子を渡す（#1264）。**Signalyへの通知だけだと、通知を消した時点で
# 承認待ちであることを知る手段が無くなる。** 宛先と鍵はpollerと同じ`dispatch.env`から読む。
# 未設定・失敗のいずれでも実装は止めない（このスクリプトの約束）。
report_activity_to_issue_deck() {
  local env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}"
  [[ -f "$env_file" ]] || return 0
  local app_base_url dispatch_secret
  # shellcheck disable=SC1090
  app_base_url="$(source "$env_file" >/dev/null 2>&1; printf '%s' "${APP_BASE_URL:-}")"
  # shellcheck disable=SC1090
  dispatch_secret="$(source "$env_file" >/dev/null 2>&1; printf '%s' "${DISPATCH_SECRET:-}")"
  [[ -n "$app_base_url" && -n "$dispatch_secret" && -n "$REPO_SLUG" && -n "$ISSUE_NUMBER" ]] || return 0

  local body
  body="$(ACTIVITY="$ACTIVITY" REMOTE_URL="$REMOTE_URL" REPO_SLUG="$REPO_SLUG" \
    ISSUE_NUMBER="$ISSUE_NUMBER" python3 -c '
import json, os
print(json.dumps({
    "repository": os.environ["REPO_SLUG"],
    "issue": int(os.environ["ISSUE_NUMBER"]),
    "activity": os.environ["ACTIVITY"],
    "remoteControlUrl": os.environ.get("REMOTE_URL") or None,
}))' 2>/dev/null || true)"
  [[ -n "$body" ]] || return 0

  curl -fsS --max-time 10 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $dispatch_secret" \
    -d "$body" \
    "${app_base_url%/}/api/dispatch/sessions/activity" >/dev/null 2>&1 ||
    echo "session-notify: issue-deckへの様子の報告に失敗しました（実装は続行します）" >&2
}
report_activity_to_issue_deck

if [[ -z "$WEBHOOK_URL" ]]; then
  # 未設定は異常ではない。通知を使わない環境ではこれが正常な経路（状態の記録だけ行う）。
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
