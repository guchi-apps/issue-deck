#!/usr/bin/env bash
# 実装セッションの状態をSignalyへ通知するフックスクリプト（#1219）。
#
# Claude Codeのフック（`Notification`・`Stop`・`PreToolUse`・`PostToolUse`）から呼ばれ、
# フックのstdinに来るJSONを読んで1件処理する。設定は run-issue-session.sh が生成する
# settings JSON 側にあり、このスクリプトを直接叩くのは検証のときだけ。
#
# 扱うイベントは4つ。**どれを扱うかの判定はすべてここが持つ**（フック設定には「呼ぶ」ことだけを
# 書き、判断を2箇所に分けない）。
#
#   Notification(permission_prompt) 入力待ち  → Signalyへ通知＋issue-deckへ様子を報告
#                                               （＋`00.check-user`を付ける。#1417）
#   Stop                            応答終了  → 同上（＋`00.check-user`を解く保険。#1342）
#   PreToolUse(ExitPlanMode)        計画の提示 → issue-deckへ計画を送る（#1342）。**Signalyへは送らない**
#                                               （＋この時点で「入力待ち」として記録する。#1438）
#   PostToolUse（入力待ちの直後だけ） 作業再開  → issue-deckへ様子を報告（#1357）。**Signalyへは送らない**
#                                               （＋`00.check-user`を解く。#1417）
#
# **`00.check-user`を付け外しするのは、自分が付けたときだけ**（印は`lib/session-state.sh`の
# `<セッション名>.check-user`）。Issueに書かれた「Claudeがユーザーに質問したとき」
# 「開発環境のリンクを提示したとき」「スクリーンショットを提示したとき」は、ローカルセッションでは
# どれも「入力待ちで止まる」という同じ形になるため、契機を分けずに扱う（#1417）。
#
# `ExitPlanMode`でSignalyへ送らないのは、直後に承認プロンプトの`Notification`が必ず飛び、
# 同じ「入力待ち」が二重になるため。`PostToolUse`で送らないのは、人が答えたことは
# その人が既に知っているため（通知の価値が無く、数だけ増える）。
#
# **`PostToolUse`は「人が承認プロンプトに答えた」ことを知る唯一の手掛かり**（#1357）。答えた
# こと自体を知らせるフックは無いが、承認したツールは必ず走るので、その直後に飛ぶ。ただし
# **ツールの実行ごとに飛ぶ**ため、状態ファイル（`lib/session-state.sh`の`.event`）を見て
# 「直前が`permission_prompt`のとき」だけに間引く。
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
#   SESSION_NOTIFY_DRY_RUN=1   送信せず、送るはずのpayloadを標準出力へ出す。
#                              Signalyだけでなくissue-deckへの報告も止める（#1342で計画の投稿が
#                              GitHubへのコメント書き込みになったため、検証で実際に書かせない）

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

# tmuxのセッション名。状態ファイルのキーであり、`tmux attach -t <名前>` でそのまま繋げるよう
# 通知にも載せる。tmuxの外で起動した場合は空になる。
NOTIFY_TMUX_SESSION=""
if [[ -n "${TMUX:-}" ]]; then
  NOTIFY_TMUX_SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi
export NOTIFY_TMUX_SESSION

# 状態ファイルに残っている最後のイベント（`Stop` / `permission_prompt` / `working`）。
# **`PostToolUse`を間引くための判定材料**（#1357）。
NOTIFY_LAST_STATE_EVENT=""
if [[ -n "$NOTIFY_TMUX_SESSION" ]] && declare -F session_state_read_event >/dev/null 2>&1; then
  _last_event_line="$(session_state_read_event "$NOTIFY_TMUX_SESSION" 2>/dev/null || true)"
  if [[ "$_last_event_line" =~ ^[0-9]+[[:space:]]+([A-Za-z_]+) ]]; then
    NOTIFY_LAST_STATE_EVENT="${BASH_REMATCH[1]}"
  fi
  unset _last_event_line
fi
export NOTIFY_LAST_STATE_EVENT

# **`PostToolUse`のほとんどをここで捨てる**（#1357）。ツールの実行ごとに飛ぶイベントなので、
# 毎回python3を起こしてHTTPまで進むと実装セッションを目に見えて遅くする。
#
# ここでの文字列一致は**判定の複製ではなく、python3を起こす価値があるかの前捌き**（`ExitPlanMode`の
# `NOTIFY_PLAN_BASE_SHA`と同じ扱い）。外れた場合はpython側の判定へ落ちるだけで、結果は変わらない。
# 「`PostToolUse`だと確実に読めて、かつ直前が入力待ちではない」ときにしか打ち切らない。
if [[ "$HOOK_JSON" =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"PostToolUse\" ]] &&
  [[ "$NOTIFY_LAST_STATE_EVENT" != "permission_prompt" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 送るかどうかの判定とpayloadの組み立て
#
# 判定・組み立て・シェルへ返す値の生成をすべてpython3側に寄せる。フックのJSONを
# シェルでパースする（grep -o 等）と、値に引用符や改行が入った時点で壊れるため。
# 標準出力の1行目を「何をするか」、2行目以降をpayloadとして返す。
#
#   send <状態イベント> <activity> <remote-controlのURL|->   Signalyへ通知する（payloadはSignaly用）
#   quiet <状態イベント> <activity>                          issue-deckへだけ報告する（#1357）
#   plan <remote-controlのURL|->                            計画を送る（payloadは/sessions/plan用）
#   skip                                                    何もしない
#
# イベント名を返すのはシェル側がセッションの状態として記録するため（#1256）、
# URLを返すのはissue-deckの画面へ渡すため（#1264）。
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

# 計画コメントの先頭に残す前提コミット（#1342）。手でIssueへ投稿していたときと同じ形
# （`<!-- plan-base: <SHA> -->`）を保ち、`git log <SHA>..origin/develop`で前提の変化を
# 辿れるようにする（docs/multi-agent/gates.md）。フックはworktree上で動くので、そのまま引ける。
#
# **JSONの中身の判定はここでは行わない**（判定はpython側の1箇所に集める）。ここでの文字列一致は
# 「`git`を2回呼ぶ価値があるか」を決めるだけの前捌きで、外れても計画の投稿には影響しない。
NOTIFY_PLAN_BASE_SHA=""
if [[ "$HOOK_JSON" == *ExitPlanMode* ]]; then
  NOTIFY_PLAN_BASE_SHA="$(git rev-parse origin/develop 2>/dev/null ||
    git rev-parse origin/main 2>/dev/null || true)"
fi
export NOTIFY_PLAN_BASE_SHA

result="$(python3 - <<'PY' 2>/dev/null || true
import glob
import json
import os
import re
import sys

# 転記ファイル（transcript）から計画ファイルのパスを探すときに読む末尾の量。
# 長いセッションでは数MBになるため、全部は読まない。
TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024

try:
    hook = json.loads(os.environ.get("HOOK_JSON", ""))
except Exception:
    sys.exit(0)
if not isinstance(hook, dict):
    sys.exit(0)

event = hook.get("hook_event_name", "")
notification_type = hook.get("notification_type", "")

issue_number = os.environ.get("NOTIFY_ISSUE_NUMBER", "")
repo_name = os.environ.get("NOTIFY_REPO_NAME", "")
repo_slug = os.environ.get("NOTIFY_REPO_SLUG", "").strip("/")
host_name = os.environ.get("NOTIFY_HOST_NAME", "")
tmux_session = os.environ.get("NOTIFY_TMUX_SESSION", "")

# 通知のタイトルに出すホストの表記（#1416）。**issue-deck側の`src/lib/dispatch/host-label.ts`と
# 同じ対応表を持つ。** ここは通知を組み立てる時点でホスト名しか持っておらず、issue-deckへ問い
# 合わせる経路も無い（通知は起動先が落ちていても届く必要がある）ため、写しを置く方を選んでいる。
# **APIへ送る`hostName`と「Host」フィールドは識別子のまま**にする（照合キーであり、`ssh`・
# `tmux`の相手でもある）。
HOST_DISPLAY_NAMES = {"subpc": "サブPC"}
host_display_name = HOST_DISPLAY_NAMES.get(host_name.lower(), host_name)


def resolve_remote_url():
    """remote-controlのURL（best-effort）。

    `~/.claude/sessions/<pid>.json` に sessionId と bridgeSessionId の対応がある。
    **非公開の内部ファイルなので、読めなくても・形が変わっても処理自体は落とさない。**
    `--remote-control` を付けずに起動した場合は bridgeSessionId が無く、URLも取れない。
    """
    session_id = hook.get("session_id", "")
    if not session_id:
        return ""
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
                return f"https://claude.ai/code/{bridge}"
            break
    except Exception:
        return ""
    return ""


def resolve_plan_text(tool_input):
    """提示された計画の本文を取り出す。

    **今のClaude Codeでは、計画は`ExitPlanMode`の引数では渡ってこない**（実測。ツールの説明も
    「This tool does NOT take the plan content as a parameter - it will read the plan from the
    file you wrote」と言っている）。計画はplan modeの開始時に指示された
    `~/.claude/plans/<スラッグ>.md`へエージェントが書き、ツールはそれを読む。

    そこでフックのJSONにある`transcript_path`を末尾から読み、**エージェントが最後に
    `Write`/`Edit`した`~/.claude/plans/`配下のファイル**を計画ファイルとみなして中身を読む。

    - **末尾から探すのは、最後に書かれた計画が欲しいから**（却下されて書き直された場合、
      新しいものが後ろに来る）。転記ファイルは数MBになりうるので全部は読まない
    - **ツールの引数から拾い、本文の文字列一致では探さない。** 転記ファイルにはコマンドの
      出力や引用も入るため、パスらしき文字列を拾うと別セッションの計画ファイルを掴む
    - **候補は`~/.claude/plans/`直下の`.md`に限る。** 転記ファイルの中身はエージェントの
      出力そのもので、任意のパスを読ませないため
    - 引数で渡ってくる版に当たった場合はそれを優先する（版差に強くしておく）
    """
    if isinstance(tool_input, dict):
        direct = tool_input.get("plan")
        if isinstance(direct, str) and direct.strip():
            return direct.strip()

    transcript = hook.get("transcript_path") or ""
    if not transcript:
        return ""
    plans_dir = os.path.join(os.path.expanduser("~"), ".claude", "plans")
    try:
        size = os.path.getsize(transcript)
        with open(transcript, "rb") as f:
            if size > TRANSCRIPT_TAIL_BYTES:
                f.seek(size - TRANSCRIPT_TAIL_BYTES)
                f.readline()  # 途中から読み始めた1行目は壊れているので捨てる
            lines = f.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return ""

    # **本文の文字列一致ではなく、`Write`/`Edit`の引数から拾う。** 転記ファイルには
    # コマンドの出力や引用も入るので、単に「`~/.claude/plans/`配下のパスらしき文字列」を
    # 探すと、別セッションの計画ファイルの話をしただけの行を掴む（実際に踏んだ）。
    plan_path = ""
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except Exception:
            continue
        message = entry.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") not in ("Write", "Edit"):
                continue
            path = (block.get("input") or {}).get("file_path")
            if isinstance(path, str) and path.endswith(".md") and os.path.dirname(path) == plans_dir:
                plan_path = path
                break
        if plan_path:
            break
    if not plan_path:
        return ""
    try:
        with open(plan_path, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


# 計画の提示（#1342）。**`ExitPlanMode`の`PreToolUse`は、承認プロンプトが出る前に飛ぶ。**
# ここが計画をIssueへ残す唯一の機会で、`Notification`のJSONには計画に関する情報が何も無い。
#
# 送り先はSignalyではなくissue-deck。**計画本文を外部サービスへ出す経路は作らない**という
# 方針（下の「応答テキストは載せない」と同じ理由）を守りつつ、Issueのコメントとしてなら
# 残す価値がある（元々プロンプトが手で投稿するよう指示していたもの）。
if event == "PreToolUse" and hook.get("tool_name", "") == "ExitPlanMode":
    plan = resolve_plan_text(hook.get("tool_input"))
    # 宛先が引けない・計画が読めないなら何もしない。issue-deck側もこれらは400で弾く。
    # **読めなかったときに黙って諦めるのは、プロンプト側に手で投稿する経路が残っているため**
    if not plan or not repo_slug or not issue_number.isdigit():
        print("skip")
        sys.exit(0)
    remote_url = resolve_remote_url()
    print("plan", remote_url or "-")
    print(json.dumps({
        "repository": repo_slug,
        "issue": int(issue_number),
        "plan": plan,
        "remoteControlUrl": remote_url or None,
        "planBaseSha": os.environ.get("NOTIFY_PLAN_BASE_SHA") or None,
        "hostName": host_name or None,
    }))
    sys.exit(0)

# 人が承認プロンプト・質問に答えて作業へ戻ったこと（#1357）。
#
# **答えたことを直接知らせるフックは無い。** 承認したツールは必ず走るので、その`PostToolUse`を
# 「答えた合図」として使う。ただしツールの実行ごとに飛ぶため、**直前の状態が`permission_prompt`の
# ときだけ**扱う（シェル側が状態ファイルから読んで渡してくる）。1回報告すれば状態ファイルは
# `working`になるので、続くツールの実行では自然に止まる。
#
# **Signalyへは送らない。** 答えたのは人自身で、通知を受け取る意味が無い。
if event == "PostToolUse":
    if os.environ.get("NOTIFY_LAST_STATE_EVENT", "") != "permission_prompt":
        print("skip")
        sys.exit(0)
    print("quiet", "working", "working")
    sys.exit(0)

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

remote_url = resolve_remote_url()


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
    title_parts.append(f"({host_display_name})")
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

# issue-deckへの報告に使う宛先と鍵は、pollerと同じ`dispatch.env`から読む（#1264）。
# **未設定でも失敗でも実装は止めない**（このスクリプトの約束）。設定していないホストでは
# Signalyへの通知だけが飛び、画面には出ないだけになる。
dispatch_env_value() {
  local env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}" key="$1"
  [[ -f "$env_file" ]] || return 0
  # shellcheck disable=SC1090
  (
    source "$env_file" >/dev/null 2>&1
    printf '%s' "${!key:-}"
  )
}

# issue-deckのAPIへJSONを1件投げる。送れなかったときだけ非0で返す。
# **失敗の理由にURLや鍵を混ぜない**（tmuxのスクロールバックに残るため）。
post_to_issue_deck() {
  local path="$1" body="$2" app_base_url dispatch_secret
  [[ -n "$body" ]] || return 1
  app_base_url="$(dispatch_env_value APP_BASE_URL)"
  dispatch_secret="$(dispatch_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 1
  # 検証時（#1342でGitHubへ実際にコメントを書くようになったため）はここも送らない。
  # 送信先の判定までは通っているので、宛先と本文だけを出す
  if [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]]; then
    printf '%s %s\n' "$path" "$body"
    return 0
  fi
  curl -fsS --max-time 10 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $dispatch_secret" \
    -d "$body" \
    "${app_base_url%/}$path" >/dev/null 2>&1
}

# 計画をIssueへ残す（#1342）。**Signalyへは送らない**（直後の承認プロンプトの通知と二重になる）。
report_plan_to_issue_deck() {
  local body="$1"
  if ! post_to_issue_deck /api/dispatch/sessions/plan "$body"; then
    echo "session-notify: 計画のIssueへの投稿に失敗しました（実装は続行します）" >&2
    return 0
  fi
  [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]] && return 0
  mark_check_user_pending
}

# **付けられたときだけ印を残す。** ラベルを外すのは印があるときだけなので、付けられて
# いないのに印を残すと、人が別の理由で付けた`00.check-user`を落としに行くことになる。
# tmuxの外で起動したセッションは印を置く場所（キーがtmuxのセッション名）が無い
mark_check_user_pending() {
  [[ -n "$NOTIFY_TMUX_SESSION" ]] || return 0
  declare -F session_state_mark_check_user_pending >/dev/null 2>&1 || return 0
  session_state_mark_check_user_pending "$NOTIFY_TMUX_SESSION" ||
    echo "session-notify: ユーザーの確認待ちを記録できませんでした（実装は続行します）" >&2
}

decision_line="$(printf '%s' "$result" | head -1)"
# 形式: `send <状態イベント> <activity> <URL または "-">` / `quiet <状態イベント> <activity>` /
#       `plan <URL または "-">` / `skip`
decision="${decision_line%% *}"

if [[ "$decision" == "plan" ]]; then
  report_plan_to_issue_deck "$(printf '%s' "$result" | tail -n +2)"
  # **計画を出した時点で、このセッションは人の答えを待っている**（#1438）。承認プロンプトの
  # `Notification`が飛ぶのを待たずにここで記録する。
  #
  # 記録しておかないと、承認の直後の`PostToolUse`が「直前が入力待ちではない」として
  # 捨てられ（#1357の間引き）、承認したのに`00.check-user`が応答終了（`Stop`）まで
  # 外れない。`Notification`はここまでの実測では必ず飛んでいるが、**外れるかどうかが
  # 別のフックの有無に依存している状態を残さない**（承認と同時に外れることが、
  # 画面から見て「承認が効いた」ことの唯一の合図）。
  #
  # `permission_prompt`は回収（`reap-sessions.sh`）から見ても「人を待っている」で、
  # `Stop`以外は畳まれないため、早く記録して困ることは無い。
  if [[ -n "$NOTIFY_TMUX_SESSION" ]] && declare -F session_state_record_event >/dev/null 2>&1; then
    session_state_record_event "$NOTIFY_TMUX_SESSION" permission_prompt ||
      echo "session-notify: セッションの状態を記録できませんでした（実装は続行します）" >&2
  fi
  exit 0
fi

if [[ "$decision" != "send" && "$decision" != "quiet" ]]; then
  exit 0
fi
read -r _ STATE_EVENT ACTIVITY REMOTE_URL <<<"$decision_line"
[[ "$REMOTE_URL" == "-" ]] && REMOTE_URL=""

# このセッションが入力待ちに入ったこと（#1417）。**`00.check-user`を付けるのはここだけ。**
# `Notification / permission_prompt`はAskUserQuestionの質問と権限の承認プロンプトで飛ぶ、
# 「エージェントが人に聞いて止まっている」ことを知る唯一のフックで、
# Issue #1417の「質問したとき」「開発環境のリンクを提示したとき」「スクリーンショットを
# 提示したとき」はローカルセッションではすべてこの形になる。
CHECK_USER_REQUESTED=0
if [[ "$STATE_EVENT" == "permission_prompt" ]]; then
  CHECK_USER_REQUESTED=1
fi

# 自分で付けた`00.check-user`を解いてよいか（#1342・#1417）。**印があるときだけ。**
# `Stop`はturnごとに飛ぶので、無条件に外すと人が別の理由で付けたラベルまで落とす。
#
# 解く契機は2つ。`working`（＝人が承認プロンプト・質問に答えて作業へ戻った。#1357）が本命で、
# Issue #1417の「ユーザーが質問に返信したとき」「計画を承認・修正したとき」に対応する。
# `Stop`は保険で、計画を却下されて`PostToolUse`が飛ばなかった場合など、答えたことを
# `working`で拾えなかった経路を拾う。
CHECK_USER_RESOLVED=0
if [[ ("$STATE_EVENT" == "Stop" || "$STATE_EVENT" == "working") && -n "$NOTIFY_TMUX_SESSION" ]] &&
  declare -F session_state_check_user_pending >/dev/null 2>&1 &&
  session_state_check_user_pending "$NOTIFY_TMUX_SESSION"; then
  CHECK_USER_RESOLVED=1
fi

# セッションの状態を記録する（#1256）。**送信より先に行う。**
# webhookが未設定でも・Signalyが落ちていても、回収の判定材料はホストに残る必要がある。
# tmuxの外で起動したセッション（セッション名が空）は回収の対象外なので記録しない。
if [[ -n "$STATE_EVENT" && -n "$NOTIFY_TMUX_SESSION" ]] &&
  declare -F session_state_record_event >/dev/null 2>&1; then
  session_state_record_event "$NOTIFY_TMUX_SESSION" "$STATE_EVENT" ||
    echo "session-notify: セッションの状態を記録できませんでした（実装は続行します）" >&2
fi

# issue-deckの画面へも同じ様子を渡す（#1264）。**Signalyへの通知だけだと、通知を消した時点で
# 承認待ちであることを知る手段が無くなる。**
#
# `00.check-user`の付け外し（#1342・#1417）も同じ往復に載せる。**受け口を分けないのは、
# 「今どうしている」と「確認待ちに入った／出た」が同じイベントで、往復を2回にする理由が
# 無いため。** JSONのキーが`planResolved`のままなのは、issue-deck本体とサブPCのデプロイ順が
# ずれても壊れないようにするため（意味は#1417で「このセッションが付けた`00.check-user`を
# 外してよい」へ広げた）。
report_activity_to_issue_deck() {
  [[ -n "$REPO_SLUG" && -n "$ISSUE_NUMBER" ]] || return 0

  local body
  body="$(ACTIVITY="$ACTIVITY" REMOTE_URL="$REMOTE_URL" REPO_SLUG="$REPO_SLUG" \
    ISSUE_NUMBER="$ISSUE_NUMBER" CHECK_USER_RESOLVED="$CHECK_USER_RESOLVED" \
    CHECK_USER_REQUESTED="$CHECK_USER_REQUESTED" python3 -c '
import json, os
print(json.dumps({
    "repository": os.environ["REPO_SLUG"],
    "issue": int(os.environ["ISSUE_NUMBER"]),
    "activity": os.environ["ACTIVITY"],
    "remoteControlUrl": os.environ.get("REMOTE_URL") or None,
    "planResolved": os.environ.get("CHECK_USER_RESOLVED") == "1",
    "checkUserRequested": os.environ.get("CHECK_USER_REQUESTED") == "1",
}))' 2>/dev/null || true)"

  if ! post_to_issue_deck /api/dispatch/sessions/activity "$body"; then
    echo "session-notify: issue-deckへの様子の報告に失敗しました（実装は続行します）" >&2
    return 0
  fi
  [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]] && return 0
  if [[ "$CHECK_USER_REQUESTED" == "1" ]]; then
    mark_check_user_pending
  fi
  # **報告できたときだけ印を消す。** 消してから失敗すると、ラベルが付いたまま外す手掛かりが
  # 無くなる。残っていれば次の`Stop`でもう一度外しに行ける（既に外れていても404は無視される）
  if [[ "$CHECK_USER_RESOLVED" == "1" ]] &&
    declare -F session_state_clear_check_user_pending >/dev/null 2>&1; then
    session_state_clear_check_user_pending "$NOTIFY_TMUX_SESSION" || true
  fi
}
report_activity_to_issue_deck

# 作業再開の報告（#1357）はここまで。**Signalyへは送らない**（答えたのは人自身で、
# 同じことを通知し返す意味が無い）。
if [[ "$decision" == "quiet" ]]; then
  exit 0
fi

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
