#!/usr/bin/env bash
# 実装セッションの状態をSignalyへ通知するフックスクリプト（#1219）。
#
# Claude Codeのフック（`Notification`・`Stop`・`PreToolUse`・`PostToolUse`・`SessionStart`）から呼ばれ、
# フックのstdinに来るJSONを読んで1件処理する。設定は run-issue-session.sh が生成する
# settings JSON 側にあり、このスクリプトを直接叩くのは検証のときだけ。
#
# 扱うイベントは6つ。**どれを扱うかの判定はすべてここが持つ**（フック設定には「呼ぶ」ことだけを
# 書き、判断を2箇所に分けない）。
#
#   Notification(permission_prompt) 入力待ち  → Signalyへ通知＋issue-deckへ様子を報告
#                                               （＋`00.check-user`を付ける。#1417）
#   Stop                            応答終了  → 同上（＋`00.check-user`を解く保険。#1342）
#   PreToolUse(ExitPlanMode)        計画の提示 → issue-deckへ計画を送る（#1342）。**Signalyへは送らない**
#   PreToolUse(AskUserQuestion)     質問 → issue-deckへ質問を送り、画面からの回答を待つ（#2189）
#                                               （＋この時点で「入力待ち」として記録する。#1438）
#   PostToolUse（入力待ちの直後だけ） 作業再開  → issue-deckへ様子を報告（#1357）。**Signalyへは送らない**
#                                               （＋`00.check-user`を解く。#1417）
#   PostToolUse(Artifact)           アーティファクトの公開 → HTMLの原本をissue-deckへ送る（#2154）。
#                                               **Signalyへは送らない。** 上の間引きより前で扱う
#   SessionStart                    セッション開始 → 「まだ開始していない」印を消すだけ（#1465）。
#                                               **Signalyへもissue-deckへも送らない**
#
# **1つだけフック以外の入口がある**（#1971）。`SessionInterrupted`はClaude Codeのフックではなく、
# pollerが合成して渡してくる合図で、「APIエラー（529等）でturnが打ち切られたまま止まっている」
# ことを人へ引き上げる。このときClaude Codeは`Stop`を飛ばさないため、フックだけを待っていると
# 誰にも伝わらない。**Signalyへ通知するだけ**で、状態の記録もissue-deckへの報告も行わない。
# 対象のセッション名は`SESSION_NOTIFY_TMUX_SESSION`で受け取る（`$TMUX`が使えないため）。
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

# 計画を出したあと、issue-deckの画面からの返事を何秒まで待つか（#2061）。
#
# **待っている間、端末には承認プロンプトが出ない。** 待ち切ると（あるいはissue-deckが
# 応答しなければ）何も返さずに終え、従来どおりのプロンプトが出る。`0`で待たない。
# 上限・下限と既定はissue-deck側（`src/lib/dispatch/session-plan-request.ts`）が持っており、
# ここで渡した値はそこで丸められる。
PLAN_WAIT_SECONDS="${SESSION_PLAN_WAIT_SECONDS:-1800}"
[[ "$PLAN_WAIT_SECONDS" =~ ^[0-9]+$ ]] || PLAN_WAIT_SECONDS=1800
export NOTIFY_PLAN_WAIT_SECONDS="$PLAN_WAIT_SECONDS"
# 返事を確かめる間隔（秒）。画面のポーリング（未完了があるときは5秒）より短くして、
# 押してからセッションが動き出すまでの体感を短く保つ
PLAN_POLL_INTERVAL_SECONDS="${SESSION_PLAN_POLL_INTERVAL_SECONDS:-3}"
[[ "$PLAN_POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] && ((PLAN_POLL_INTERVAL_SECONDS > 0)) ||
  PLAN_POLL_INTERVAL_SECONDS=3
# issue-deckへ届かない状態がここまで続いたら待つのをやめる（秒。#2108）。
#
# **1回の失敗で降りない。** 宛先は本番のissue-deck（`APP_BASE_URL`）で、30分待つあいだに
# 数百回引くため、途中で1回失敗することは普通に起きる。実際に**35回目あたりの1回の失敗で
# 待ちを降り**、画面にはカウントダウンが残ったまま誰も受け取らない状態になった
# （#2103の2回目の計画。フックは108秒で終了していた）。
PLAN_POLL_GRACE_SECONDS="${SESSION_PLAN_POLL_GRACE_SECONDS:-60}"
[[ "$PLAN_POLL_GRACE_SECONDS" =~ ^[0-9]+$ ]] || PLAN_POLL_GRACE_SECONDS=60

# `AskUserQuestion`で聞いたあと、issue-deckの画面からの回答を何秒まで待つか（#2189）。
#
# **計画の待ち時間と別に持つ。** 既定は同じ30分だが、片方だけ切りたい場面がある
# （質問はよく出るので端末に座っているときは即答したい、など）。**間隔と猶予は計画と
# 共有する**——どちらも「issue-deckへ何秒おきに引き、届かない状態が何秒続いたら降りるか」
# という同じ性質の値で、2つに分けても片方だけ調整する理由が無い。
QUESTION_WAIT_SECONDS="${SESSION_QUESTION_WAIT_SECONDS:-1800}"
[[ "$QUESTION_WAIT_SECONDS" =~ ^[0-9]+$ ]] || QUESTION_WAIT_SECONDS=1800
export NOTIFY_QUESTION_WAIT_SECONDS="$QUESTION_WAIT_SECONDS"

# セッションの状態ファイル（#1256）。読み書きの作法は回収スクリプトと共有する。
# **無くても通知は続ける**（このスクリプトはセッションを止めないことが最優先）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/lib/session-state.sh" ]]; then
  # shellcheck source=scripts/lib/session-state.sh
  source "$SCRIPT_DIR/lib/session-state.sh" || true
fi

# tmuxのセッション名。状態ファイルのキーであり、`tmux attach -t <名前>` でそのまま繋げるよう
# 通知にも載せる。tmuxの外で起動した場合は空になる。
#
# **`SESSION_NOTIFY_TMUX_SESSION`で外から渡せる**（#1971）。APIエラーで中断したセッションの
# 引き上げは、そのセッションの中ではなくpollerから呼ばれるため`$TMUX`が使えない。
# 渡された名前はそのセッションを指すだけで、ここから送る操作は無い（読むのと通知だけ）。
NOTIFY_TMUX_SESSION=""
if [[ -n "${SESSION_NOTIFY_TMUX_SESSION:-}" ]]; then
  NOTIFY_TMUX_SESSION="$SESSION_NOTIFY_TMUX_SESSION"
elif [[ -n "${TMUX:-}" ]]; then
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

# 「まだ開始していない」印（`lib/session-state.sh`の`.starting`）を消す（#1465）。
#
# ランチャーが`claude`の起動直前に置いた印が消えないまま猶予（既定180秒）を過ぎると、pollerが
# それをissue-deckへ報告し、画面に「まだ開始していません」と出て`00.check-user`が付く。
# 消す本来の契機は`SessionStart`だが、**どのイベントでも消す。** フックが1つでも飛んだ時点で
# Claude Codeは開始しており、`SessionStart`だけに任せると、そのフックが何らかの理由で飛ばない
# 環境（古いClaude Code等）で正常なセッションのたびに誤って引き上げることになる。
if [[ -n "$NOTIFY_TMUX_SESSION" ]] && declare -F session_state_clear_starting >/dev/null 2>&1; then
  session_state_clear_starting "$NOTIFY_TMUX_SESSION" || true
fi

# セッションが始まった（#1465）。**印を消す以外にやることは無いので、ここで打ち切る。**
# 開始したこと自体は人にとって新しい情報ではない（画面には既に起動の受付コメントが出ている）
# ため、Signalyへもissue-deckへも送らない（python3もHTTPも起こさない）。
if [[ "$HOOK_JSON" =~ \"hook_event_name\"[[:space:]]*:[[:space:]]*\"SessionStart\" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 公開したアーティファクトをissue-deckへ取り込む（#2154）
#
# **claude.aiのアーティファクトページはiframeに入らない**（`content-security-policy:
# frame-ancestors 'self'`。実測）。URLだけを送っても「ブラウザに遷移せずにアプリ上で見る」
# ことにならないので、**HTMLの原本ごと**送る。issue-deckは自分のオリジンから出し直す。
#
# **下の`PostToolUse`の間引きより前に置く。** 間引きは「直前が入力待ちのとき」しか通さないが、
# アーティファクトの公開の直前に承認プロンプトが出るとは限らず、任せるとほとんどが捨てられる。
#
# `dispatch_env_value`をここで定義しているのは、この処理が間引きより前に来るため
# （bashの関数は呼ぶ前に定義されている必要がある）。宛先と鍵の出どころはpollerと同じ
# `dispatch.env`で、他の報告（`post_to_issue_deck`）と共有している。
# ---------------------------------------------------------------------------
dispatch_env_value() {
  local env_file="${ISSUE_DECK_DISPATCH_ENV:-$HOME/.config/issue-deck/dispatch.env}" key="$1"
  [[ -f "$env_file" ]] || return 0
  # shellcheck disable=SC1090
  (
    source "$env_file" >/dev/null 2>&1
    printf '%s' "${!key:-}"
  )
}

# **HTMLの解釈はshellでやらない。** ファイルの読み出しもJSONの組み立てもpython側に寄せ、
# ここは「送るかどうか」と送信だけを持つ。判定に外れた場合はpythonが何も出さず、静かに終わる。
report_artifact_to_issue_deck() {
  local app_base_url dispatch_secret payload
  [[ -n "$ISSUE_NUMBER" && -n "$REPO_SLUG" ]] || return 0
  app_base_url="$(dispatch_env_value APP_BASE_URL)"
  dispatch_secret="$(dispatch_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 0

  payload="$(
    HOOK_JSON="$HOOK_JSON" \
      ARTIFACT_REPO_SLUG="$REPO_SLUG" \
      ARTIFACT_ISSUE_NUMBER="$ISSUE_NUMBER" \
      ARTIFACT_HOST_NAME="${DISPATCH_HOST_NAME:-$(hostname -s 2>/dev/null || echo unknown)}" \
      python3 - <<'PY' 2>/dev/null || true
import json
import os
import re
import sys

# issue-deck側（`src/lib/dispatch/session-artifact.ts`）と同じ上限。**超える分はここで諦める**
# （送っても400で返ってくるだけで、その往復に意味が無い）。
LIMIT = 2 * 1024 * 1024

try:
    hook = json.loads(os.environ.get("HOOK_JSON", ""))
except Exception:
    sys.exit(0)
if not isinstance(hook, dict) or hook.get("hook_event_name") != "PostToolUse":
    sys.exit(0)
if hook.get("tool_name") != "Artifact":
    sys.exit(0)

tool_input = hook.get("tool_input")
if not isinstance(tool_input, dict):
    sys.exit(0)
# `Artifact`は公開以外（list / read / comments / upload_asset …）にも使う。**公開だけを拾う。**
# 既定（省略時）が公開なので、Noneと空文字も通す
if tool_input.get("action") not in (None, "", "publish"):
    sys.exit(0)
source_path = tool_input.get("file_path")
if not isinstance(source_path, str) or not source_path.strip():
    sys.exit(0)
source_path = source_path.strip()

try:
    with open(source_path, "rb") as handle:
        raw = handle.read(LIMIT + 1)
except OSError:
    sys.exit(0)
if not raw or len(raw) > LIMIT:
    sys.exit(0)
try:
    html = raw.decode("utf-8")
except UnicodeDecodeError:
    sys.exit(0)

# 公開したURLはツールの応答から拾う。**取れなくても送る**——見た目を出すのに要るのはHTMLの
# 原本だけで、URLはclaude.aiで開き直すための逃げ道にすぎない
response = hook.get("tool_response")
if not isinstance(response, str):
    response = json.dumps(response, ensure_ascii=False)
found = re.search(
    r"https://claude\.ai/(?:code/artifact|public/artifacts)/"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    response,
)


def text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


sys.stdout.write(
    json.dumps(
        {
            "repository": os.environ["ARTIFACT_REPO_SLUG"],
            "issue": int(os.environ["ARTIFACT_ISSUE_NUMBER"]),
            "hostName": text(os.environ.get("ARTIFACT_HOST_NAME")),
            "title": text(tool_input.get("title")),
            "description": text(tool_input.get("description")),
            "favicon": text(tool_input.get("favicon")),
            "claudeUrl": found.group(0) if found else None,
            "sourcePath": source_path,
            "html": html,
        },
        ensure_ascii=False,
    )
)
PY
  )"
  [[ -n "$payload" ]] || return 0

  if [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]]; then
    # **本文（HTML）は出さない。** 検証で見たいのは宛先と拾えた項目で、数百KBのHTMLが
    # 端末へ流れると他が読めなくなる
    printf '/api/dispatch/sessions/artifact %s\n' "${payload:0:300}"
    return 0
  fi

  # **本文が大きいので引数ではなく標準入力から渡す。** `-d "$payload"` だと数百KBのHTMLが
  # `ps` の出力にも argv の上限にも掛かる。失敗しても黙って終える（このスクリプトの約束）
  printf '%s' "$payload" | curl -fsS --max-time 20 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $dispatch_secret" \
    --data-binary @- \
    "${app_base_url%/}/api/dispatch/sessions/artifact" >/dev/null 2>&1 || true
}

# python3を起こす価値があるかの前捌き（`NOTIFY_PLAN_BASE_SHA`と同じ扱い）。
# 外れてもpython側が同じ判定で落とすので、結果は変わらない。
if [[ "$HOOK_JSON" == *'"tool_name"'*'"Artifact"'* ]]; then
  report_artifact_to_issue_deck
fi

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
#   notify <->  <-> <remote-controlのURL|->                 Signalyへ通知するだけ（#1971。記録も報告もしない）
#   quiet <状態イベント> <activity>                          issue-deckへだけ報告する（#1357）
#   plan <remote-controlのURL|->                            計画を送る（payloadは/sessions/plan用。
#                                                           4行目に`ExitPlanMode`の引数を添える。#2121）
#   question <remote-controlのURL|->                        質問を送る（payloadは/sessions/question用。
#                                                           4行目に`AskUserQuestion`の引数を添える。#2189）
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
    - 引数で渡ってくる版に当たった場合はそれを優先する（版差に強くしておく）。
      **Claude Code 2.1.239の実測では`tool_input.plan`に本文が入っていた**（#2108）。
      どちらかへ寄せると、寄せた側でない版に当たった時点で計画が載らなくなる
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


def build_signaly_payload(emoji, color, label, remote_url):
    """Signalyへ送るpayloadを組み立てる（#2061でここだけ関数へ切り出した）。

    計画の承認待ち（`plan`）も通知したいが、あちらは`decision`ブロックより手前で
    確定するため、同じ組み立てを2箇所に持たずに済むようにしている。
    """
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
    # 中断の引き上げ（#1971）に添える一文。**pollerが持つ固定の文言だけが入る**
    # （セッションの画面や応答テキストは、他のイベントと同じくここへ載せない）。
    interrupt_detail = hook.get("interrupt_detail", "")
    if isinstance(interrupt_detail, str) and interrupt_detail.strip():
        fields.append({"name": "詳細", "value": interrupt_detail.strip(), "inline": False})
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
    return {"title": title, "color": color, "fields": fields}


# 計画の提示（#1342）。**`ExitPlanMode`の`PreToolUse`は、承認プロンプトが出る前に飛ぶ。**
# ここが計画をIssueへ残す唯一の機会で、`Notification`のJSONには計画に関する情報が何も無い。
#
# 送り先はSignalyではなくissue-deck。**計画本文を外部サービスへ出す経路は作らない**という
# 方針（下の「応答テキストは載せない」と同じ理由）を守りつつ、Issueのコメントとしてなら
# 残す価値がある（元々プロンプトが手で投稿するよう指示していたもの）。
#
# **Signalyへは「計画の承認待ち」だけを送る（#2061）。** 従来はここで送らず、直後に飛ぶ
# 承認プロンプトの`Notification`に任せていた。画面から承認できるようになると、承認された
# 場合は承認プロンプトが出ない＝`Notification`が飛ばないため、任せたままだと
# **計画が出たことが誰にも通知されない。** 載せるのは他のイベントと同じ項目だけで、
# 計画本文は入れない。
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
        "waitSeconds": int(os.environ.get("NOTIFY_PLAN_WAIT_SECONDS") or 0),
    }))
    print(json.dumps(build_signaly_payload("\U0001f5d2\ufe0f", "#faa61a", "計画の承認待ち", remote_url)))
    # 4行目は`ExitPlanMode`の引数そのまま（#2121）。承認を返すときに`updatedInput`として
    # 添え直すためだけに持ち出すので、**中身は一切変えない**（`plan_decision_output`を参照）。
    tool_input = hook.get("tool_input")
    print(json.dumps(tool_input if isinstance(tool_input, dict) else {}))
    sys.exit(0)

# 質問（#2189）。**`AskUserQuestion`の`PreToolUse`は、選択フォームが出る前に飛ぶ。**
# ここが質問の中身（選択肢とその説明）を画面へ運ぶ唯一の機会で、`Notification`のJSONには
# 何を聞かれているかが入っていない。
#
# **Signalyへは「質問の回答待ち」を送る。** 画面から答えた場合は選択フォームが出ない＝
# `Notification`が飛ばないため、任せたままだと質問が出たことが誰にも届かない。
# 載せるのは他のイベントと同じ項目だけで、質問の中身は入れない。
if event == "PreToolUse" and hook.get("tool_name", "") == "AskUserQuestion":
    tool_input = hook.get("tool_input")
    questions = tool_input.get("questions") if isinstance(tool_input, dict) else None
    # 宛先が引けない・質問が読めないなら何もしない。issue-deck側もこれらは400で弾く
    if not isinstance(questions, list) or not questions or not repo_slug or not issue_number.isdigit():
        print("skip")
        sys.exit(0)
    remote_url = resolve_remote_url()
    print("question", remote_url or "-")
    print(json.dumps({
        "repository": repo_slug,
        "issue": int(issue_number),
        "questions": questions,
        "hostName": host_name or None,
        "waitSeconds": int(os.environ.get("NOTIFY_QUESTION_WAIT_SECONDS") or 0),
    }))
    print(json.dumps(build_signaly_payload("\U0001f64b", "#faa61a", "質問の回答待ち", remote_url)))
    # 4行目は`AskUserQuestion`の引数そのまま。回答を返すときに`answers`だけを足して
    # `updatedInput`として添え直す（`question_decision_output`を参照）
    print(json.dumps(tool_input if isinstance(tool_input, dict) else {}))
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
#
# `decision`は下の1行にそのまま出る。`notify`はSignalyへ通知するだけで、状態の記録も
# issue-deckへの報告も行わない（#1971。フックではなくpollerから来る合図のため、
# 「今このセッションが何をしているか」を表す値を持たない）。
decision = "send"

if event == "SessionInterrupted":
    # APIエラー（529 Overloaded など）でturnが打ち切られ、止まったままのセッション（#1971）。
    # **これはClaude Codeのフックではなく、pollerが合成して渡してくる合図。**
    # このときClaude Codeは`Stop`を飛ばさないため、ここが人へ届く唯一の経路になる。
    # pollerは自動再開を上限まで試したあとにだけ呼ぶ（1セッションにつき1回）。
    emoji = "⚠️"
    color = "#ed4245"
    label = "APIエラーで中断"
    state_event = "-"
    activity = "-"
    decision = "notify"
elif event == "Stop":
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


print(decision, state_event, activity, remote_url or "-")
print(json.dumps(build_signaly_payload(emoji, color, label, remote_url)))
PY
)"

# python3が無い・落ちた場合は result が空になる。そのときも黙って終わる。
if [[ -z "$result" ]]; then
  exit 0
fi

# issue-deckへの報告に使う宛先と鍵は、pollerと同じ`dispatch.env`から読む（#1264）。
# **未設定でも失敗でも実装は止めない**（このスクリプトの約束）。設定していないホストでは
# Signalyへの通知だけが飛び、画面には出ないだけになる。
# 読み出しの`dispatch_env_value`はアーティファクトの取り込み（#2154）でも使うため、
# `PostToolUse`の間引きより前で定義してある。

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

# issue-deckのAPIへJSONを1件投げ、**応答本文を標準出力へ返す**（#2061）。
# 計画の投稿だけがこちらを使う（返ってくる`planRequestId`が、画面からの返事を待つ相手になる）。
post_to_issue_deck_capture() {
  local path="$1" body="$2" app_base_url dispatch_secret
  [[ -n "$body" ]] || return 1
  app_base_url="$(dispatch_env_value APP_BASE_URL)"
  dispatch_secret="$(dispatch_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 1
  if [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]]; then
    # **本文は先頭だけ出す**（#2200）。計画にアーティファクトのHTMLが入ると数百KBになり、
    # 端末へ丸ごと流れると他が読めなくなる（アーティファクトの送出と同じ扱い）
    printf '%s %s\n' "$path" "${body:0:300}" >&2
    return 0
  fi
  # **計画の投稿はGitHubへコメントを書く往復を含む**ので、報告（`post_to_issue_deck`）より
  # 長く待つ。ここで切れると`planRequestId`が返らず、サーバー側には返事待ちができているのに
  # フックは待たない＝画面にだけ「承認を待っています」が残る（#2108）。
  #
  # **本文は引数ではなく標準入力から渡す**（#2200）。計画にアーティファクトのHTMLを埋めて
  # 差し替えられるようになったため、ここを通る本文は数百KBになりうる。`-d "$body"`だと
  # `ps`の出力にも argv の上限にも掛かり、送信ごと落ちる（＝`planRequestId`が返らず、
  # 計画コメントも承認パネルも出ない）。アーティファクトの送出が同じ理由で
  # `--data-binary @-`にしてある
  printf '%s' "$body" | curl -fsS --max-time 30 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $dispatch_secret" \
    --data-binary @- \
    "${app_base_url%/}$path" 2>/dev/null
}

# issue-deckのAPIをGETで1回引き、応答本文を標準出力へ返す（#2061）。
get_from_issue_deck() {
  local path="$1" app_base_url dispatch_secret
  app_base_url="$(dispatch_env_value APP_BASE_URL)"
  dispatch_secret="$(dispatch_env_value DISPATCH_SECRET)"
  [[ -n "$app_base_url" && -n "$dispatch_secret" ]] || return 1
  curl -fsS --max-time 10 \
    -H "Authorization: Bearer $dispatch_secret" \
    "${app_base_url%/}$path" 2>/dev/null
}

# JSONの応答から文字列のフィールドを1つ取り出す。**取れなければ空**（判定は呼び出し側）。
json_field() {
  local body="$1" key="$2"
  [[ -n "$body" ]] || return 0
  BODY="$body" KEY="$key" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["BODY"]).get(os.environ["KEY"])
except Exception:
    sys.exit(0)
if isinstance(value, str):
    sys.stdout.write(value)
' 2>/dev/null || true
}

# JSONの応答からフィールドを1つ、**JSONのまま**取り出す（#2189）。取れなければ空。
# 回答（`answers`）はオブジェクトなので、文字列だけを返す`json_field`では受け取れない。
json_object_field() {
  local body="$1" key="$2"
  [[ -n "$body" ]] || return 0
  BODY="$body" KEY="$key" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["BODY"]).get(os.environ["KEY"])
except Exception:
    sys.exit(0)
if isinstance(value, dict) and value:
    sys.stdout.write(json.dumps(value))
' 2>/dev/null || true
}

# Signalyへ通知を1件送る（#2061でここだけ関数へ切り出した）。webhookが未設定・payloadが空なら
# 何もしない。**これはこのスクリプトの終端だけでなく、計画の承認待ち（`plan`）からも呼ばれる。**
notify_signaly() {
  local payload="$1"
  # 未設定は異常ではない。通知を使わない環境ではこれが正常な経路（状態の記録だけ行う）。
  [[ -n "$WEBHOOK_URL" && -n "$payload" ]] || return 0

  if [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]]; then
    printf '%s\n' "$payload"
    return 0
  fi

  # 応答が返らないwebhookで実装セッションを待たせないため、必ずタイムアウトを掛ける。
  if ! curl -fsS --max-time 10 \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$WEBHOOK_URL" >/dev/null 2>&1; then
    # 失敗理由をURLごと出すとwebhookのシークレットがセッションのログに残る。1行に留める。
    echo "session-notify: Signalyへの通知に失敗しました（実装は続行します）" >&2
  fi
}

# 計画をIssueへ残す（#1342）。**画面からの返事を待つ相手のid**（#2061）を標準出力へ返す。
# 返らなければ待たずに終える＝端末に従来どおりの承認プロンプトが出る。
report_plan_to_issue_deck() {
  local body="$1" response=""
  if ! response="$(post_to_issue_deck_capture /api/dispatch/sessions/plan "$body")"; then
    echo "session-notify: 計画のIssueへの投稿に失敗しました（実装は続行します）" >&2
    return 0
  fi
  [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]] && return 0
  mark_check_user_pending
  json_field "$response" planRequestId
}

# 画面からの返事を待ち、Claude Codeの許可判定として標準出力へ返す（#2061）。
#
# **これは`send-keys`の例外ではない。** 端末へは何も送らず、`PreToolUse`フックの戻り値
# （`hookSpecificOutput.permissionDecision`）としてClaude Code自身に判定させる。
# 承認プロンプトの選択フォームに答えさせる操作はどこにも無い
# （docs/multi-agent/gates.md）。
#
# **決まらなければ何も出力しない（フェイルオープン）。** 待ち切った・「端末で答える」を
# 押された・issue-deckが応答しない、のいずれでも従来どおりの承認プロンプトが端末に出る。
#
# **issue-deckへ届かないことを理由に降りるのは、その状態が`PLAN_POLL_GRACE_SECONDS`続いた
# ときだけ**（#2108）。降りるときは`release_plan_request`で画面の待ちも畳む。
wait_for_plan_decision() {
  local request_id="$1" deadline response outcome failing=0 failed_since=0
  [[ -n "$request_id" ]] || return 0
  ((PLAN_WAIT_SECONDS > 0)) || return 0

  deadline=$((SECONDS + PLAN_WAIT_SECONDS))
  while ((SECONDS < deadline)); do
    if response="$(get_from_issue_deck "/api/dispatch/sessions/plan/decision?id=$request_id")"; then
      failing=0
      outcome=0
      plan_decision_from_response "$response" || outcome=$?
      # 0＝決まった（判定は出力済み）／2＝もう決まらない／1＝まだ待つ
      if ((outcome != 1)); then
        return 0
      fi
    else
      # **1回の失敗では降りない**（#2108）。宛先は本番のissue-deckで、30分待つあいだに
      # 数百回引くため、瞬断や再起動で1回外すことは普通に起きる。ここで即座に降りると、
      # 画面にはカウントダウンが残ったまま、押しても誰も受け取らないパネルになる。
      if ((failing == 0)); then
        failing=1
        failed_since=$SECONDS
      fi
      if ((SECONDS - failed_since >= PLAN_POLL_GRACE_SECONDS)); then
        echo "session-notify: 計画の返事をissue-deckから取得できない状態が${PLAN_POLL_GRACE_SECONDS}秒続きました（端末で答えてください）" >&2
        release_plan_request "$request_id"
        return 0
      fi
    fi
    sleep "$PLAN_POLL_INTERVAL_SECONDS"
  done
  # 待ち切った。**畳むのはサーバー側**（期限を過ぎた行は`EXPIRED`へ倒す）なので、
  # ここからは何も伝えない
}

# 応答の`status`を許可判定に変える。**出力するのはここだけ**（poll中と、待ちを畳むときの
# 最後の確認の2箇所から同じ形で呼ぶ）。
#
#   0 … 決まった（`plan_decision_output`で出力済み）
#   1 … まだ決まっていない（`WAITING`）
#   2 … もう決まらない（`DEFERRED`・`EXPIRED`・`GONE`、および想定外の値）
plan_decision_from_response() {
  local response="$1" status revision
  status="$(json_field "$response" status)"
  case "$status" in
    APPROVED)
      plan_decision_output allow "issue-deckの画面で承認されました"
      return 0
      ;;
    REVISION_REQUESTED)
      revision="$(json_field "$response" revisionText)"
      # **`deny`の理由がそのまま次の指示になる。** 空で返すとClaudeは何を直せばよいか
      # 分からないため、その場合も理由を明示する
      plan_decision_output deny "${revision:-issue-deckの画面で計画の修正を求められました。}"
      return 0
      ;;
    WAITING)
      return 1
      ;;
  esac
  return 2
}

# 待つのをやめたことをissue-deckへ伝える（#2108）。**伝えないと画面は待ち時間いっぱい
# 「計画の承認を待っています」を出し続け、押しても誰も受け取らないボタンが残る。**
#
# **応答は最後の確認も兼ねる。** サーバーが畳むのは`WAITING`の行だけなので、降りると決めた
# 直後に押されていればその結論が返り、そのまま許可判定として使える。
# **届かなければ何もしない**（届かないことが降りる理由なので、失敗は想定内）。
release_plan_request() {
  local request_id="$1" response
  # 自分が受け取ったidをそのままJSONへ入れる。念のため形だけ確かめる（cuid）
  [[ "$request_id" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  response="$(post_to_issue_deck_capture /api/dispatch/sessions/plan/decision \
    "{\"id\":\"$request_id\"}")" || return 0
  plan_decision_from_response "$response" || true
}

# `PreToolUse`フックの戻り値。**標準出力のJSONだけがClaude Codeに読まれる**ので、
# ここ以外はすべて標準エラーへ出す約束になっている。
#
# **承認（`allow`）には`updatedInput`を必ず添える**（#2121）。Claude Codeは`ExitPlanMode`を
# 「許可が下りていても人へ聞き直す」ツール（`requiresUserInteraction`）として扱っており、
# `allow`だけを返しても端末に承認プロンプトが出る——**画面で承認したのにRemote Controlで
# もう一度承認する二重承認**になっていた（実測: このスクリプトが`allow`を返した95秒後、
# 人が押した2回目の承認でようやくツールが走った）。フックが`updatedInput`を返したときだけ
# その聞き直しを省く作りなので、受け取った`tool_input`をそのまま添える。
#
# **中身は変えない。** ここは「入力を差し替える」機能の副作用を借りているだけで、計画本文を
# 書き換える意図は無い。`deny`はもともと聞き直されずClaudeへ渡るため添えない。
plan_decision_output() {
  local decision="$1" reason="$2"
  DECISION="$decision" REASON="$reason" TOOL_INPUT="${PLAN_TOOL_INPUT:-}" python3 -c '
import json, os

output = {
    "hookEventName": "PreToolUse",
    "permissionDecision": os.environ["DECISION"],
    "permissionDecisionReason": os.environ["REASON"],
}
if output["permissionDecision"] == "allow":
    try:
        updated = json.loads(os.environ.get("TOOL_INPUT") or "{}")
    except Exception:
        updated = {}
    # 読めなかった・形が違うときも空の辞書を添える。**添えること自体が承認プロンプトを
    # 省く条件**で、省略すると二重承認へ戻る。計画本文はツールが計画ファイルから読み直す。
    output["updatedInput"] = updated if isinstance(updated, dict) else {}
print(json.dumps({"hookSpecificOutput": output}))' 2>/dev/null || true
}

# 質問をissue-deckへ送る（#2189）。**画面からの回答を待つ相手のid**を標準出力へ返す。
# 返らなければ待たずに終える＝端末に従来どおりの選択フォームが出る。
report_question_to_issue_deck() {
  local body="$1" response=""
  if ! response="$(post_to_issue_deck_capture /api/dispatch/sessions/question "$body")"; then
    echo "session-notify: 質問のissue-deckへの送信に失敗しました（実装は続行します）" >&2
    return 0
  fi
  [[ "${SESSION_NOTIFY_DRY_RUN:-}" == "1" ]] && return 0
  mark_check_user_pending
  json_field "$response" questionRequestId
}

# 画面からの回答を待ち、Claude Codeの許可判定として標準出力へ返す（#2189）。
#
# **これは`send-keys`の例外ではない。** 端末へは何も送らず、`PreToolUse`フックの戻り値
# （`hookSpecificOutput`）としてClaude Code自身に判定させる。選択フォームに答えさせる操作は
# どこにも無い（docs/multi-agent/gates.md）。
#
# 待ち方は計画（`wait_for_plan_decision`）とまったく同じ——**issue-deckへ届かないことを理由に
# 降りるのは、その状態が`PLAN_POLL_GRACE_SECONDS`続いたときだけ**で、降りるときは
# `release_question_request`で画面の待ちも畳む。
wait_for_question_answer() {
  local request_id="$1" deadline response outcome failing=0 failed_since=0
  [[ -n "$request_id" ]] || return 0
  ((QUESTION_WAIT_SECONDS > 0)) || return 0

  deadline=$((SECONDS + QUESTION_WAIT_SECONDS))
  while ((SECONDS < deadline)); do
    if response="$(get_from_issue_deck "/api/dispatch/sessions/question/decision?id=$request_id")"; then
      failing=0
      outcome=0
      question_decision_from_response "$response" || outcome=$?
      # 0＝決まった（判定は出力済み）／2＝もう決まらない／1＝まだ待つ
      if ((outcome != 1)); then
        return 0
      fi
    else
      if ((failing == 0)); then
        failing=1
        failed_since=$SECONDS
      fi
      if ((SECONDS - failed_since >= PLAN_POLL_GRACE_SECONDS)); then
        echo "session-notify: 質問の回答をissue-deckから取得できない状態が${PLAN_POLL_GRACE_SECONDS}秒続きました（端末で答えてください）" >&2
        release_question_request "$request_id"
        return 0
      fi
    fi
    sleep "$PLAN_POLL_INTERVAL_SECONDS"
  done
  # 待ち切った。**畳むのはサーバー側**（期限を過ぎた行は`EXPIRED`へ倒す）
}

# 応答の`status`を許可判定に変える。**出力するのはここだけ**（poll中と、待ちを畳むときの
# 最後の確認の2箇所から同じ形で呼ぶ）。
#
#   0 … 決まった（`question_decision_output`で出力済み）
#   1 … まだ決まっていない（`WAITING`）
#   2 … もう決まらない（`DEFERRED`・`EXPIRED`・`GONE`、および想定外の値）
question_decision_from_response() {
  local response="$1" status answers
  status="$(json_field "$response" status)"
  case "$status" in
    ANSWERED)
      answers="$(json_object_field "$response" answers)"
      # **回答が空なら決まっていないのと同じ**。空の`answers`を返すとツールの結果が
      # 「(no option selected)」になり、端末で答え直す機会も無いまま先へ進む
      [[ -n "$answers" ]] || return 2
      question_decision_output "$answers"
      return 0
      ;;
    WAITING)
      return 1
      ;;
  esac
  return 2
}

# 待つのをやめたことをissue-deckへ伝える（#2189。計画の`release_plan_request`と同じ）。
release_question_request() {
  local request_id="$1" response
  [[ "$request_id" =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  response="$(post_to_issue_deck_capture /api/dispatch/sessions/question/decision \
    "{\"id\":\"$request_id\"}")" || return 0
  question_decision_from_response "$response" || true
}

# `PreToolUse`フックの戻り値。**標準出力のJSONだけがClaude Codeに読まれる。**
#
# **`allow`＋`updatedInput`で回答そのものを渡す。** `AskUserQuestion`は入力に`answers`
# （質問文 → 回答文字列）が入っていればそれをそのまま結果にするツールで、フックが
# `updatedInput`を返したときだけ「許可が下りていても人へ聞き直す」挙動
# （`requiresUserInteraction`）が省かれる（#2121で計画について確かめたのと同じ仕組み。
# Claude Code 2.1.241のバイナリで確認）。つまり**選択フォームを出さずに回答を届けられる。**
#
# **質問（`questions`）は受け取ったままを添える。** 変えてよいのは`answers`だけで、
# `updatedInput`はツールのスキーマ検証を通るため、質問を作り変えると回答ごと弾かれる。
question_decision_output() {
  local answers="$1"
  ANSWERS="$answers" TOOL_INPUT="${QUESTION_TOOL_INPUT:-}" python3 -c '
import json, os

try:
    updated = json.loads(os.environ.get("TOOL_INPUT") or "{}")
except Exception:
    updated = {}
if not isinstance(updated, dict):
    updated = {}
try:
    answers = json.loads(os.environ.get("ANSWERS") or "{}")
except Exception:
    answers = {}
if not isinstance(answers, dict) or not answers:
    raise SystemExit(0)
updated["answers"] = answers
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "issue-deckの画面で回答されました",
    "updatedInput": updated,
}}))' 2>/dev/null || true
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
#       `plan <URL または "-">` / `question <URL または "-">` / `skip`
decision="${decision_line%% *}"

if [[ "$decision" == "plan" ]]; then
  # 2行目が計画（issue-deck向け）、3行目が通知（Signaly向け）、4行目が`ExitPlanMode`の引数。
  # **行を分けているのは、計画本文を外部サービスへ出す経路を作らないため**（通知には計画が
  # 入らない）
  PLAN_REQUEST_ID="$(report_plan_to_issue_deck "$(printf '%s' "$result" | sed -n '2p')")"
  # 4行目は`ExitPlanMode`の引数そのまま。承認を返すときに`updatedInput`として添え直す（#2121）
  PLAN_TOOL_INPUT="$(printf '%s' "$result" | sed -n '4p')"
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

  # **ここでSignalyへ通知する**（#2061）。画面から承認された場合は承認プロンプトが出ない＝
  # `Notification`が飛ばないため、任せたままだと計画が出たことが誰にも届かない。
  notify_signaly "$(printf '%s' "$result" | sed -n '3p')"

  # 画面からの返事を待つ。**決まらなければ何も出力せずに終える**（端末に従来どおりの
  # 承認プロンプトが出る）
  wait_for_plan_decision "$PLAN_REQUEST_ID"
  exit 0
fi

if [[ "$decision" == "question" ]]; then
  # 2行目が質問（issue-deck向け）、3行目が通知（Signaly向け）、4行目が`AskUserQuestion`の引数。
  # **行を分けているのは、質問の中身を外部サービスへ出す経路を作らないため**（通知には
  # 選択肢が入らない）
  QUESTION_REQUEST_ID="$(report_question_to_issue_deck "$(printf '%s' "$result" | sed -n '2p')")"
  # 4行目は`AskUserQuestion`の引数そのまま。回答を返すときに`answers`を足して
  # `updatedInput`として添え直す
  QUESTION_TOOL_INPUT="$(printf '%s' "$result" | sed -n '4p')"
  # **質問を出した時点で、このセッションは人の答えを待っている**（#1438と同じ理由）。
  # 選択フォームの`Notification`が飛ぶのを待たずにここで記録する——画面から答えた場合は
  # そもそも飛ばないので、記録しておかないと承認直後の`PostToolUse`が「直前が入力待ちでは
  # ない」として捨てられ、答えたのに`00.check-user`が応答終了まで外れない
  if [[ -n "$NOTIFY_TMUX_SESSION" ]] && declare -F session_state_record_event >/dev/null 2>&1; then
    session_state_record_event "$NOTIFY_TMUX_SESSION" permission_prompt ||
      echo "session-notify: セッションの状態を記録できませんでした（実装は続行します）" >&2
  fi

  # **ここでSignalyへ通知する**（計画と同じ理由）。画面から答えられた場合は選択フォームが
  # 出ない＝`Notification`が飛ばないため、任せたままだと質問が出たことが誰にも届かない
  notify_signaly "$(printf '%s' "$result" | sed -n '3p')"

  # 画面からの回答を待つ。**決まらなければ何も出力せずに終える**（端末に従来どおりの
  # 選択フォームが出る）
  wait_for_question_answer "$QUESTION_REQUEST_ID"
  exit 0
fi

if [[ "$decision" != "send" && "$decision" != "quiet" && "$decision" != "notify" ]]; then
  exit 0
fi
read -r _ STATE_EVENT ACTIVITY REMOTE_URL <<<"$decision_line"
[[ "$REMOTE_URL" == "-" ]] && REMOTE_URL=""

# 中断の引き上げ（#1971）はSignalyへ通知するだけ。**状態の記録もissue-deckへの報告も行わない。**
# これはフックではなくpollerから来る合図で、「今このセッションが何をしているか」を表す値を
# 持たない（`working`のまま止まっている、が最後に分かっている事実）。空にして、以降の
# 記録・報告の条件から自然に外す。
if [[ "$decision" == "notify" ]]; then
  STATE_EVENT=""
  ACTIVITY=""
fi

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
# `activity`を持たない通知（#1971）はここを通さない。
if [[ -n "$ACTIVITY" ]]; then
  report_activity_to_issue_deck
fi

# 作業再開の報告（#1357）はここまで。**Signalyへは送らない**（答えたのは人自身で、
# 同じことを通知し返す意味が無い）。
if [[ "$decision" == "quiet" ]]; then
  exit 0
fi

notify_signaly "$(printf '%s' "$result" | tail -n +2)"

exit 0
