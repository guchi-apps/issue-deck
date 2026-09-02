#!/usr/bin/env bash
# 作業が終わった実装セッション（tmuxセッションと`claude`プロセス）を畳む（#1256）。
# #1223 の第0段階（孤児の開発サーバー回収）・第1段階（アイドルな開発サーバーの停止）に続く第2段階。
#
# 使い方:
#   scripts/reap-sessions.sh                    条件を満たすセッションを畳む
#   scripts/reap-sessions.sh --dry-run          判定だけ表示し、何も畳まない
#   scripts/reap-sessions.sh --idle-minutes 90  猶予（分）を指定する（0で回収を行わない）
#   scripts/reap-sessions.sh --handoff-idle-minutes 60   引き渡し済みの猶予を指定する
#   scripts/reap-sessions.sh --question-idle-minutes 45  質問セッションの放置の猶予を指定する
#
# 環境変数:
#   SESSION_IDLE_MINUTES          最後の`Stop`からこの分数が経つまで畳まない（既定5・0で無効）。
#                                 効くのはIssueがCLOSED・PRがマージ済みの経路
#   SESSION_HANDOFF_IDLE_MINUTES  `11.local`を外してローカル作業を終えた（＝マージもcloseも
#                                 まだの）セッション専用の猶予（既定5・0でこの経路だけ無効）。
#                                 PRを作って引き渡した場合（#1541）と、PRを作らずに終わった
#                                 場合（#1600）の両方に効く。**SESSION_IDLE_MINUTESとは
#                                 独立**で、こちらの経路ではこの値だけを見る（#1649）
#   QUESTION_SESSION_IDLE_MINUTES 横断質問セッション（kind=question）専用の猶予（既定30・
#                                 0でこの経路だけ無効＝従来どおり質問IssueがCLOSEDになるまで
#                                 残す）。**質問IssueがOPENのままでも畳む**（#1648）
#   ISSUE_DECK_SESSION_STATE_DIR  状態ファイルの置き場（既定は ~/.local/state/issue-deck/sessions）
#
# ## なぜ要るか
#
# `claude`は対話プロセスで、作業が終わってもプロンプト待ちに戻るだけで**終了しない**。
# `tmux new-session`に渡したコマンドが終わらない以上セッションは残る。同時実行数の上限
# （`AppSetting.dispatchConcurrency`）は**ジョブの払い出しにしか効かない**（tmuxが立った時点で
# ジョブは`succeeded`）ため、生きているセッションの本数には上限が無く、放置すると積み上がる。
# 実測（2026-08-14・サブPC）では10本が残り、うち5本は対応IssueがCLOSED済みだった。
#
# ## 判定の作法
#
# **これは計器であって役ではない**（docs/multi-agent/gates.md「計器」）。判断はせず、決まった条件に
# 当てはまるセッションを畳んで記録するだけで、LLMも人への問い合わせも挟まない。
#
# **画面（`capture-pane`）の内容は読まない。** 画面の文字列から状態を推定する方式は実地で誤判定した
# 実績がある（#1219・#1223）。読むのはフックが残した状態ファイル・tmuxのメタデータ・gitとGitHubの事実だけ。
#
# **判定できないときは必ず「畳まない」側へ倒す。** 畳むと文脈が失われ、取り返せない
# （#1178 ではPRのマージ後に追加指示が来て同じセッションを再利用した実績がある）。
#
# **Pull Requestを人の指示で作るリポジトリ（scripts/local-repo-pr-policy.conf）では、
# 引き渡し済みの2経路（#1541・#1600）をPRができるまで通さない**（#2499）。そこでは
# 「PRが無い＝もう作業しない」が成り立たず、構想を同じセッションで練り直している最中に
# あたる。判定は起動プロンプトを組み立てる generic-start-issue.sh と共有する
# （scripts/lib/pr-policy.sh）。
#
# ## 畳む予定を画面へ出す（#1817）
#
# 条件がすべて揃い、あとは猶予が経つのを待っているだけのセッションには、畳む予定
# （`<セッション名>.reap` = `<期限のepoch> <理由コード>`）を書く。pollerがそれを読んで
# issue-deckへ報告し、画面に「あと3分」と出る。**判定はここにしか無い**
# （worktreeがcleanか・push済みかはこのホストのファイルシステムにしか無く、画面側からは
# 同じ判定を組み立てられない）。書くのは`hold_until_reap`の1か所だけで、条件を満たさない
# セッションでは`reap_one`の入口で消える。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 状態ファイルの置き場と読み書きは、書く側（run-issue-session.sh・session-notify.sh）と共有する。
# shellcheck source=scripts/lib/session-state.sh
source "$SCRIPT_DIR/lib/session-state.sh"

# Pull Requestを人の指示で作るリポジトリかどうか（#2499）。起動プロンプトを組み立てる側
# （generic-start-issue.sh）と同じ判定を使う。ここだけ従来のままだと、PRを作らない前提で
# 動いているセッションが「PRを作らずに終えた」と読まれて畳まれる。
# shellcheck source=scripts/lib/pr-policy.sh
source "$SCRIPT_DIR/lib/pr-policy.sh"

# IssueがCLOSED・PRがマージ済みの経路で使う猶予（#1256）。既定を60から5へ下げた（#1649）。
# 畳めるセッションが残っている時間は、そのまま本数の上限（DISPATCH_MAX_SESSIONS・#1361）を
# 埋めて新規セッションの待ち時間になる。サブPCで1.7日・134件を5分で畳んだ実測では、畳んだ後に
# 呼び戻したケースが1件も無かった（そもそも畳んでも`--continue`で会話の続きから再開できる）。
IDLE_MINUTES="${SESSION_IDLE_MINUTES:-5}"
# ローカル作業を終えた（`11.local`を外した）セッション専用の猶予（#1541・#1600）。
# **共通猶予（IDLE_MINUTES）とは独立で、この経路ではこちらだけを見る**（#1649）。以前は共通猶予を
# 通過したうえでさらにこの値を見るAND判定で、実効が max(IDLE, HANDOFF) になっており、既定の
# 60/30では30が一度も効いていなかった（「CLOSED・マージ済みより長めに取る」という段差は成立して
# いなかった）。横断質問セッション（QUESTION_SESSION_IDLE_MINUTES）と同じ置き換え方式に揃える。
# 0でこの経路だけを無効にできる。
HANDOFF_IDLE_MINUTES="${SESSION_HANDOFF_IDLE_MINUTES:-5}"
# 横断質問セッション（`kind=question`）専用の猶予（#1648）。**質問IssueがOPENのままでも畳む。**
# 追い質問を送らないまま忘れられたセッションは、質問Issueを閉じる人がいない限り永久に残り、
# 本数の上限（DISPATCH_MAX_SESSIONS・#1361）を1本ずつ埋める。実装セッションと違って
# worktreeもコミットも持たないため、畳んでも失うのは会話の文脈だけで、取り返しがつく。
# 0でこの経路だけを無効にできる（従来どおりCLOSEDになるまで残す）。
QUESTION_IDLE_MINUTES="${QUESTION_SESSION_IDLE_MINUTES:-30}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --idle-minutes)
      IDLE_MINUTES="${2:-}"
      shift 2 || true
      ;;
    --handoff-idle-minutes)
      HANDOFF_IDLE_MINUTES="${2:-}"
      shift 2 || true
      ;;
    --question-idle-minutes)
      QUESTION_IDLE_MINUTES="${2:-}"
      shift 2 || true
      ;;
    *)
      echo "Usage: scripts/reap-sessions.sh [--dry-run] [--idle-minutes <分>] [--handoff-idle-minutes <分>] [--question-idle-minutes <分>]" >&2
      exit 1
      ;;
  esac
done

# 設定は外部（dispatch.env・引数）から来るので、数値であることを確かめてから使う。
# 不正な値で猶予が0分になり、応答が終わった直後のセッションを次々畳むのを防ぐ。
if [[ ! "$IDLE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Error: 猶予は0以上の整数（分）で指定してください: $IDLE_MINUTES" >&2
  exit 1
fi
if [[ ! "$HANDOFF_IDLE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Error: 引き渡し済みの猶予は0以上の整数（分）で指定してください: $HANDOFF_IDLE_MINUTES" >&2
  exit 1
fi
if [[ ! "$QUESTION_IDLE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Error: 質問セッションの猶予は0以上の整数（分）で指定してください: $QUESTION_IDLE_MINUTES" >&2
  exit 1
fi

if [[ "$IDLE_MINUTES" -eq 0 ]]; then
  echo "セッションの回収は無効です（猶予0分）。"
  exit 0
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "セッションの回収を行いません（tmux コマンドが見つかりません）。"
  exit 0
fi

# Issueの状態・ラベル・PRの確認に`gh`が要る。**pollerの必須コマンドは増やさない**（`gh`が無い
# ホストでもジョブの取得と開発サーバーの回収は続けられるべきなので、ここだけを諦める）。
if ! command -v gh >/dev/null 2>&1; then
  echo "セッションの回収を行いません（gh コマンドが見つかりません）。"
  exit 0
fi

NOW="$(date +%s)"
IDLE_SECONDS=$((IDLE_MINUTES * 60))
HANDOFF_IDLE_SECONDS=$((HANDOFF_IDLE_MINUTES * 60))
QUESTION_IDLE_SECONDS=$((QUESTION_IDLE_MINUTES * 60))
CHECKED=0
CANDIDATES=0
REAPED=0

# 自分がその中で動いているセッション。手で実行したときに、自分の足元を畳まないための保険
# （pollerはsystemd配下でtmuxの外にいるため、通常は空）。
SELF_SESSION=""
if [[ -n "${TMUX:-}" ]]; then
  SELF_SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi

# 畳まずに残す。**理由は必ず残す**が、pollerは60秒ごとに呼ばれるため、前回と同じ理由のときは
# 出さない（同じ行でjournaldが埋まると、本来見たい回収の記録が読めなくなる）。
hold() {
  local session="$1" reason="$2"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  $session: [dry-run] 残します: $reason"
  elif session_state_reason_changed "$session" "$reason"; then
    echo "  $session: 残します: $reason"
  fi
  return 0
}

# 畳む条件は揃っているが、猶予がまだ経っていないセッション（#1817）。**残す動きはこれまでと
# 同じで、加えて「いつ・なぜ畳むか」を状態ファイル（`.reap`）へ残す。**
#
# pollerがこれを読んでissue-deckへ報告し、画面に「あと3分」と出る。残り時間を出せる
# のはここだけで、判定材料のうちworktreeがcleanか・push済みかはこのホストにしか無い。
#
# **`--dry-run`では書かない**（何も変えない道具という性質を保つ）。代わりに残り分数を表示に出す。
hold_until_reap() {
  local session="$1" deadline="$2" reason_code="$3" reason="$4" remaining
  if [[ "$DRY_RUN" -eq 1 ]]; then
    # 切り上げ（残り10秒を「あと0分」と出さない）。表示だけなのでhold()は通さない
    remaining=$(((deadline - NOW + 59) / 60))
    echo "  $session: [dry-run] 残します: $reason（あと約${remaining}分・$reason_code）"
    return 0
  fi
  # **書けなくても残す判断は変わらない**（画面に残り時間が出ないだけ）。
  session_state_write_reap "$session" "$deadline" "$reason_code" || true
  hold "$session" "$reason"
}

# 実際に畳む。**必ずログに残す。** 無人実行では「なぜセッションが消えたのか」がここにしか残らない。
# 判定は呼び出し元が済ませてある（実装セッションと横断質問セッションで条件が違うため。#1454）。
fold_session() {
  local session="$1" repository="$2" issue_number="$3" reason="$4" restart_hint="${5:-}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  $session: [dry-run] 畳む対象です（$repository #$issue_number）: $reason"
    return 0
  fi

  if tmux kill-session -t "=$session" 2>/dev/null; then
    echo "  $session: セッションを畳みました（$repository #$issue_number）: $reason"
    if [[ -n "$restart_hint" ]]; then
      echo "    $restart_hint"
    fi
    # 状態ファイルを残すと、次に同じ名前で立ったセッションが前回の`Stop`を引き継いだように見える。
    session_state_remove "$session"
    REAPED=$((REAPED + 1))
  else
    echo "  $session: 警告: セッションを畳めませんでした（$repository #$issue_number）" >&2
  fi
  return 0
}

# 1セッションを判定し、条件をすべて満たせば畳む。
# **条件は安い順に並べる**（tmux → 状態ファイル → git → GitHub API）。手前で残すと決まれば
# gh を叩かずに済み、毎分のポーリングで無駄なAPI呼び出しをしない。
#
# **猶予（時間）だけは条件の最後に見る**（#1817）。以前は`Stop`からの経過時間で先に足切りして
# いたが、それだと「畳む条件は揃っていて、あとは時間が経つのを待っているだけ」なのか
# 「そもそも畳まないセッション」なのかを、猶予が過ぎるまで区別できない。画面へ残り時間を
# 出すにはこの区別が要る。増えるのは猶予待ちのセッション1本あたり毎巡1〜2回の`gh`で、
# 猶予（既定5分）を過ぎた後は従来も毎巡叩いていた。
reap_one() {
  local session="$1"
  local descriptor reapable worktree repository issue_number kind
  local alive_panes event_line event_at event_name idle_for
  local idle_minutes idle_seconds
  local dirty remote_branches other_remote_branches issue_info issue_state issue_labels
  local local_label merged_pr open_pr handoff_reason handoff_hold handoff_code reason

  # 記述子が無いセッションには触らない。**これが「巻き込んではいけないもの」への線引き**で、
  # 他リポジトリの作業用セッション・人が手で立てたセッション・この仕組みより前から動いている
  # セッションはすべてここで外れる。
  descriptor="$(session_state_descriptor_file "$session" 2>/dev/null || true)"
  [[ -n "$descriptor" && -f "$descriptor" ]] || return 0

  # 手元のターミナルから直接起動したセッションは`reapable=0`。issue-deck側にジョブとして
  # 残らないため、畳んだ事実を後から画面で辿れない。**起動経路そのもので切る。**
  reapable="$(session_state_field "$descriptor" reapable || true)"
  [[ "$reapable" == "1" ]] || return 0

  CANDIDATES=$((CANDIDATES + 1))

  # 前の巡で書いた畳む予定（#1817）は入口で消す。**書くのは「猶予待ち」の分岐1か所だけ**に
  # しておくと、条件を満たさなくなったセッション（追加指示で作業が再開した・`11.local`が
  # 付け直された）に終了予告が残り続けることがない。
  [[ "$DRY_RUN" -eq 1 ]] || session_state_clear_reap "$session"

  if [[ -n "$SELF_SESSION" && "$session" == "$SELF_SESSION" ]]; then
    hold "$session" "この回収スクリプト自身が動いているセッション"
    return 0
  fi

  worktree="$(session_state_field "$descriptor" worktree || true)"
  repository="$(session_state_field "$descriptor" repository || true)"
  issue_number="$(session_state_field "$descriptor" issue || true)"
  # セッションの種別（#1454）。**古い記述子には無い**ので、空は実装セッションとして扱う。
  kind="$(session_state_field "$descriptor" kind || true)"
  [[ -n "$kind" ]] || kind="implementation"
  if [[ -z "$worktree" || -z "$repository" || ! "$issue_number" =~ ^[1-9][0-9]*$ ]]; then
    hold "$session" "記述子の内容が読めない（$descriptor）"
    return 0
  fi

  # 死んだペイン（`remain-on-exit failed`で残ったもの）は異常終了の証拠。**読む前に消さない。**
  alive_panes="$(tmux list-panes -s -t "=$session" -F '#{pane_dead}' 2>/dev/null | grep -cv '^1$' || true)"
  if [[ "${alive_panes:-0}" -eq 0 ]]; then
    hold "$session" "ペインが終了したまま残っている（最後の出力を読めるよう残す）"
    return 0
  fi

  # フックが残した最後のイベント（#1219・#1256）。一度も飛んでいなければ判定材料が無い。
  event_line="$(session_state_read_event "$session" || true)"
  if [[ ! "$event_line" =~ ^([0-9]+)[[:space:]]+([A-Za-z_]+)$ ]]; then
    hold "$session" "応答終了の記録がまだ無い（Stopフックが飛んでいない）"
    return 0
  fi
  event_at="${BASH_REMATCH[1]}"
  event_name="${BASH_REMATCH[2]}"

  # `permission_prompt`が最後なら、承認プロンプト・AskUserQuestionを出したまま人を待っている。
  # `working`なら、その入力に答えて作業へ戻ったまま応答が終わっていない（#1357）。
  # **どちらも畳まない**（`Stop`以外は畳まない、が判定の本体）。
  if [[ "$event_name" != "Stop" ]]; then
    if [[ "$event_name" == "working" ]]; then
      hold "$session" "入力に答えて作業中（応答終了の記録がまだ無い）"
    else
      hold "$session" "人の入力待ち（最後のイベントが $event_name）"
    fi
    return 0
  fi

  # 猶予。**`Stop`＝作業完了ではない。** レビュー結果待ちで止まっているセッションも、追加指示を
  # 受けて再開するセッションも`Stop`を出すため、ここで時間を置く。
  #
  # 横断質問セッションだけ別の値を使う（#1648）。質問には「終わった」と分かる事実（PR・マージ）が
  # 無く、放置されたぶんがそのまま本数の上限（#1361）を埋めるため、実装セッションより短く取る。
  # `QUESTION_SESSION_IDLE_MINUTES=0`はこの経路を無効にする指定なので、そのときは従来どおり
  # 共通の猶予で判定する（下の質問ブロックがCLOSEDのときだけ畳む）。
  idle_minutes="$IDLE_MINUTES"
  idle_seconds="$IDLE_SECONDS"
  if [[ ("$kind" == "question" || "$kind" == "manual-step") && "$QUESTION_IDLE_MINUTES" -gt 0 ]]; then
    idle_minutes="$QUESTION_IDLE_MINUTES"
    idle_seconds="$QUESTION_IDLE_SECONDS"
  fi
  idle_for=$((NOW - event_at))

  # **猶予そのものはここで見ない**（#1817）。**実装セッションの猶予は経路ごとに違う**
  # （CLOSED・マージ済みは`IDLE_MINUTES`、ローカル作業を終えた引き渡し済みは
  # `HANDOFF_IDLE_MINUTES`。#1649）ので、どの経路で畳むかが決まってから、その経路の猶予と
  # 突き合わせる（下の各経路の`hold_until_reap`）。

  # --- 横断質問セッション（#1454）はここで決める ---
  # **worktreeを持たず、コミットもpushもしない**（読み取り専用で、成果物は質問Issueへ投稿した
  # 回答コメントだけ）。実装セッション向けの「worktreeがcleanでpush済み」を当てると必ず
  # 「確認できない」に落ちて永久に残るため、質問Issueの状態と放置の猶予だけで決める。
  # 手作業セッション（#2771・`kind=manual-step`）も質問セッションと同じ条件で畳む。worktreeも
  # コミットも持たず、失うのは会話の文脈だけ（起こし直せば本文のチェックから続きが分かる）。
  # 文言だけを分ける（畳んだ理由が画面に出るため、「質問Issue」と書くと読み違える）
  if [[ "$kind" == "question" || "$kind" == "manual-step" ]]; then
    local issue_label restart_hint restart_hint_idle
    if [[ "$kind" == "manual-step" ]]; then
      issue_label="手作業Issue"
      restart_hint="続ける場合は、issue-deckの「Claude Codeセッションで進める」から起動し直してください（本文のチェックから続きます）。"
      restart_hint_idle="$restart_hint"
    else
      issue_label="質問Issue"
      restart_hint="もう一度聞く場合は、issue-deckの「質問する」から起動し直してください。"
      restart_hint_idle="続きを聞く場合は、issue-deckの「質問する」から新しく質問してください（畳んだセッションの会話は引き継ぎません）。"
    fi
    if ! issue_state="$(gh issue view "$issue_number" --repo "$repository" \
      --json state --jq '.state' 2>/dev/null)"; then
      hold "$session" "${issue_label}の状態を取得できない（$repository #$issue_number）"
      return 0
    fi
    if [[ "$issue_state" == "CLOSED" ]]; then
      if [[ "$idle_for" -lt "$idle_seconds" ]]; then
        # 経過時間は毎分変わるため、理由の文字列には入れない（入れると毎分ログへ出てしまう）。
        hold_until_reap "$session" "$((event_at + idle_seconds))" "QUESTION_CLOSED" \
          "${issue_label} #$issue_number はCLOSEDだが、猶予（${idle_minutes}分）が経っていない"
        return 0
      fi
      fold_session "$session" "$repository" "$issue_number" \
        "${issue_label} #$issue_number はCLOSED・最後の応答終了から$((idle_for / 60))分" \
        "$restart_hint"
      return 0
    fi
    if [[ "$QUESTION_IDLE_MINUTES" -eq 0 ]]; then
      # 放置の猶予を無効にしている場合だけ、従来どおり${issue_label}のcloseを待つ。
      hold "$session" "${issue_label} #$issue_number がまだOPEN（閉じると畳みます）"
      return 0
    fi
    # **OPENでも畳む**（#1648）。追い質問はこのセッションへ追加指示として送れる（#1012）が、
    # 送られないまま忘れられると、${issue_label}を閉じる人がいない限り永久に残る。畳んでも失うのは
    # 会話の文脈だけ（worktreeもコミットも持たない）で、回答コメントは${issue_label}に残っている。
    # 今すぐ畳みたいときは、画面のセッション表示の「終了」を押せば猶予を待たずに済む。
    if [[ "$idle_for" -lt "$idle_seconds" ]]; then
      hold_until_reap "$session" "$((event_at + idle_seconds))" "QUESTION_IDLE" \
        "${issue_label} #$issue_number はOPENだが、放置の猶予（${idle_minutes}分）が経っていない"
      return 0
    fi
    fold_session "$session" "$repository" "$issue_number" \
      "${issue_label} #$issue_number はOPENだが、最後の応答終了から$((idle_for / 60))分（放置の猶予${QUESTION_IDLE_MINUTES}分）" \
      "$restart_hint_idle"
    return 0
  fi

  # --- 畳んだ後に取り返せないものが残っていないか ---
  # **worktreeそのものが無いなら、畳んで失われるのは会話の文脈だけ**（#2422）。未コミットの
  # 変更も未pushのコミットも、置き場ごと消えている（畳むのはtmuxセッションで、ファイルは
  # 何も消さない）。ここを期限もリトライも無い`hold`にしていたため、Issueの移送・取り下げで
  # worktreeを先に消したセッションが**永久に残っていた**（自分が動いているセッションは自分では
  # kill できないので、消した本人も畳めない）。質問セッションを畳む判断（#1454）と同じ理屈で、
  # 失うものが定義上無い側へ倒す。
  #
  # **GitHub側の状態（`11.local`・Issue・PR）は見ずにここで決める。** worktreeが無い以上この
  # セッションはもう実装を続けられず、Issueを他リポジトリへ移送した場合は`gh issue view`が
  # 解決できない（実例の`guchi-apps/dayspan#420`）ため、下の経路へ進めても
  # 「Issueの状態を取得できない」という別の期限の無い`hold`に落ちるだけになる。
  #
  # 猶予（共通の`IDLE_MINUTES`）は置く。worktreeを消した直後のセッションが、後始末の続き
  # （Issueコメント・ラベルの付け替え）をしていることがあるため。
  if [[ ! -d "$worktree" ]]; then
    if [[ "$idle_for" -lt "$IDLE_SECONDS" ]]; then
      # 経過時間は毎分変わるため、理由の文字列には入れない（入れると毎分ログへ出てしまう）。
      hold_until_reap "$session" "$((event_at + IDLE_SECONDS))" "WORKTREE_GONE" \
        "worktreeが削除されている（$worktree）が、猶予（${IDLE_MINUTES}分）が経っていない"
      return 0
    fi
    fold_session "$session" "$repository" "$issue_number" \
      "worktreeが削除されている（$worktree）・最後の応答終了から$((idle_for / 60))分" \
      "もう一度作業する場合は、issue-deckの画面から起動し直してください（worktreeを作り直すため、前回の会話は引き継ぎません）。"
    return 0
  fi
  if ! dirty="$(git -C "$worktree" status --porcelain 2>/dev/null)"; then
    hold "$session" "worktreeの状態を確認できない（$worktree）"
    return 0
  fi
  if [[ -n "$dirty" ]]; then
    hold "$session" "worktreeに未コミットの変更がある"
    return 0
  fi

  # ローカルコミットがpushされているか。**ベースブランチ名を決め打ちしない**（対象リポジトリに
  # よって develop / main が混在する。#1224）。HEADを含むリモート追跡ブランチが1つでもあれば、
  # そのコミットはoriginにある。
  if ! remote_branches="$(git -C "$worktree" branch -r --contains HEAD 2>/dev/null)"; then
    hold "$session" "pushの状態を確認できない（$worktree）"
    return 0
  fi
  if [[ -z "$remote_branches" ]]; then
    hold "$session" "originへpushされていないコミットがある"
    return 0
  fi

  # HEADを含むリモート追跡ブランチのうち、**自分のトピックブランチ以外**（#1600）。
  # 1つでもあれば、このセッションのコミットは手元に残っていない（本流へ入っているか、
  # そもそも1つも作っていないか）。`origin/HEAD -> origin/develop`の別名行は数えない。
  other_remote_branches="$(printf '%s\n' "$remote_branches" \
    | sed 's/^[[:space:]*]*//' \
    | grep -v -- ' -> ' \
    | grep -vFx "origin/issue-$issue_number" || true)"

  # --- 作業が終わっているか（GitHub側の事実） ---
  # `11.local`はランチャーが起動時に付け、**実装エージェントが引き渡し時に自分で外す**ラベル
  # （scripts/prompts/implementation-agent.md）。ローカル作業の終了宣言そのものにあたる。
  #
  # **見るのは引き渡し済みの経路だけ**（#2474）。以前はここで無条件に残していたため、外し忘れた
  # セッションはPRがマージされても永久に残り、しかも畳む経路も猶予も決まらないので`.reap`が
  # 書かれず、**画面に自動終了の残り時間すら出なかった**（実例: guchi-apps/dayspan#467。
  # IssueはOPEN・`11.local`付きのまま、ブランチのPRはマージ済みだった）。成果物が本流へ入って
  # いる以上、そのworktreeでローカル作業を続ける理由は無い。人が触っている最中に消える心配は
  # 他の条件が受け持つ（最後のイベントが`Stop`＝承認待ち・作業中は畳まない、worktreeがcleanで
  # push済み）。畳んでもworktreeは残り、画面から起動し直せば前回の会話の続きから再開する。
  #
  # 代わりに、`11.local`付きでIssueがOPENのセッションでは毎巡`gh pr list`（マージ済み）を1回
  # 余計に叩く。判定を安い順に並べる方針（この関数の冒頭）からは外れるが、この1回が無いと
  # マージ済みかどうかが分からない。
  if ! issue_info="$(gh issue view "$issue_number" --repo "$repository" \
    --json state,labels --jq '.state, (.labels[].name)' 2>/dev/null)"; then
    hold "$session" "Issueの状態を取得できない（$repository #$issue_number）"
    return 0
  fi
  # `head -1`は1行読めば入力を最後まで消費せず終了するため、`printf`側が書き込み中に
  # パイプを閉じられてSIGPIPE（141）を受けることがある。`set -o pipefail`下ではその
  # 141がパイプ全体の終了ステータスになり`set -e`でスクリプトごと落ちるため、`|| true`で拾う
  # （`issue_state`自体は`head`が出力済みなので取得できる。他箇所と同じ防御。#2710のCI失敗）。
  issue_state="$(printf '%s\n' "$issue_info" | head -1 || true)"
  issue_labels="$(printf '%s\n' "$issue_info" | tail -n +2)"
  local_label=0
  if printf '%s\n' "$issue_labels" | grep -Fxq "11.local"; then
    local_label=1
  fi

  # 成果物が本流に入ったか、Issue自体が終わっているか。
  # **この2経路は`11.local`を見ない**（#2474）。理由コードは従来どおり`ISSUE_CLOSED`・
  # `PR_MERGED`なので、画面（`describeSessionReap`）側に増やすものは無い。
  #
  # **`22.merge-confirm-required`の特別扱いは要らない。** 人がマージするまでPRはopenのままなので、
  # マージ済みの経路では自動的に残る（ラベルを見る箇所を増やさない）。
  #
  # **この2経路（CLOSED・マージ済み）が見るのは`IDLE_MINUTES`**（#1649）。上の足切りは短い方の
  # 猶予で通しているため、ここで改めて共通猶予を確かめる。
  if [[ "$issue_state" == "CLOSED" ]]; then
    if [[ "$idle_for" -lt "$IDLE_SECONDS" ]]; then
      # 経過時間は毎分変わるため、理由の文字列には入れない（入れると毎分ログへ出てしまう）。
      hold_until_reap "$session" "$((event_at + IDLE_SECONDS))" "ISSUE_CLOSED" \
        "Issue #$issue_number はCLOSEDだが、猶予（${IDLE_MINUTES}分）が経っていない"
      return 0
    fi
    reason="Issue #$issue_number はCLOSED"
  else
    merged_pr="$(gh pr list --repo "$repository" --head "issue-$issue_number" --state merged \
      --json number --jq '.[0].number // empty' 2>/dev/null || true)"
    if [[ -n "$merged_pr" ]]; then
      if [[ "$idle_for" -lt "$IDLE_SECONDS" ]]; then
        hold_until_reap "$session" "$((event_at + IDLE_SECONDS))" "PR_MERGED" \
          "PR #$merged_pr はマージ済みだが、猶予（${IDLE_MINUTES}分）が経っていない"
        return 0
      fi
      reason="PR #$merged_pr がマージ済み"
    else
      # **`11.local`を見るのはここだけ**（#2474）。この経路の判定は「`11.local`を外した＝この
      # セッションでもう作業しない」という宣言を前提に組んであり、無視すると経路の意味そのものが
      # 崩れる（PRを出しただけ・PRを作らずに終えただけで、まだローカルで続けているセッションが
      # 猶予5分で畳まれる）。マージ済み・CLOSEDと違って、成果物が本流へ入った証拠がまだ無い。
      if [[ "$local_label" -eq 1 ]]; then
        hold "$session" "11.local が付いている（ローカルで作業中）"
        return 0
      fi

      # ローカル作業を終えている（#1541・#1600）。**`11.local`を外した**（すぐ上）＝
      # このセッションでもう作業しないという実装エージェント自身の宣言にあたる。ここから先は
      # PRを作ったか（#1541）・作らずに終わったか（#1600）で理由だけが分かれる。マージまで
      # 残すと、人の確認待ちのPRを抱えたセッションが本数の上限（#1361）を埋めて、後続の
      # ジョブが流れなくなる。
      #
      # **畳んでも失うものは無い。** worktreeはcleanでpush済み（条件7）、worktreeそのものは
      # 残り、呼び戻せば前回の会話の続きから再開する（#1541・run-issue-session.sh の
      # `--continue`）。
      #
      # **猶予は`HANDOFF_IDLE_MINUTES`だけで決める**（#1649）。以前は共通猶予も併せて満たす必要が
      # あり、実効が max(IDLE, HANDOFF) になっていた。「CI失敗の指摘が返る余地があるので
      # マージ済み・CLOSEDより長く取る」という段差も置いていたが、サブPCでの実測（1.7日・134件）で
      # 畳んだ後に呼び戻したケースが1件も無かったため取り下げ、短い側を指定できるようにした。
      if [[ "$HANDOFF_IDLE_SECONDS" -eq 0 ]]; then
        hold "$session" "IssueがOPENで、issue-$issue_number のPRもまだマージされていない"
        return 0
      fi
      open_pr="$(gh pr list --repo "$repository" --head "issue-$issue_number" --state open \
        --json number --jq '.[0].number // empty' 2>/dev/null || true)"

      # **Pull Requestを人の指示で作るリポジトリは、PRができるまで畳まない**（#2499）。
      # `guchi-apps/ideas`のように成果物を同じセッションで何度も練り直す使い方では、
      # 「PRが無い＝もう作業しない」が成り立たない。一覧は scripts/local-repo-pr-policy.conf。
      #
      # **ここまで来るのは`11.local`が外れているときだけ**（すぐ上のhold）で、起動プロンプトは
      # 「PRを作るまで外さない」と指示している。つまりこの分岐が効くのは、その指示どおりに
      # ならなかったとき——**プロンプトの取りこぼしに対する止め**であって主たる仕組みではない。
      # それでも置くのは、Issueが求めているのが「PRができるまで続く」という条件そのもので、
      # 指示の遵守に賭けるとこのIssueが直そうとした事象（会話が5分で消える）がそのまま残るため。
      #
      # 期限もリトライも無い`hold`にするのは、**待っているのが人の指示だから**。ここで
      # `hold_until_reap`を書くと画面に終了予告が出てしまい、指示を出せばまだ続けられる
      # セッションが「まもなく終了」と見える。**引き換えに、PRを作らずに終える構想の
      # セッションは自分では畳まれない**（`11.local`を付けたまま終えた場合と同じ状態）。
      # 畳みたくなったら画面の「終了」を押すか、Issueをcloseする（どちらも上の経路で畳まれる）。
      if [[ -z "$open_pr" ]] && pr_policy_is_manual "$repository"; then
        hold "$session" "PRを人の指示で作るリポジトリで、issue-$issue_number のPRがまだ作られていない"
        return 0
      fi

      if [[ -n "$open_pr" ]]; then
        handoff_reason="PR #$open_pr を作成しレビューへ引き渡し済み"
        handoff_hold="PR #$open_pr を引き渡してから猶予（${HANDOFF_IDLE_MINUTES}分）が経っていない"
        handoff_code="HANDOFF_PR_OPEN"
      elif [[ -n "$other_remote_branches" ]]; then
        # **PRを作らずに終わったセッション**（#1600）。子Issueへの分割・調査だけ・
        # 「対応不要」の結論のいずれかで終わると、`issue-<番号>`のPRは最後まで作られない。
        # 上の3経路（CLOSED・マージ済み・PRがopen）はどれもPRかIssueのcloseを見ているため、
        # この形のセッションはどれにも当たらず**永久に残る**（#1523のセッションが実際に残った）。
        #
        # 見分けるのは**手元に残った成果物**で、GitHub側の状態ではない。HEADが自分の
        # トピックブランチ以外のリモートブランチに含まれている＝このセッションのコミットは
        # 1つも残っていないので、畳んでも失うものが無い。独自のコミットが残っている場合は
        # 「PRを作り忘れた」可能性があるため、下の`hold`で従来どおり残す。
        handoff_reason="PRを作らずにローカル作業を終えている（このセッションのコミットが残っていない）"
        handoff_hold="ローカル作業を終えてから猶予（${HANDOFF_IDLE_MINUTES}分）が経っていない"
        handoff_code="HANDOFF_NO_PR"
      else
        hold "$session" "IssueがOPENで、issue-$issue_number のPRがまだ作られていない"
        return 0
      fi
      if [[ "$idle_for" -lt "$HANDOFF_IDLE_SECONDS" ]]; then
        # 経過時間は毎分変わるため、理由の文字列には入れない（入れると毎分ログへ出てしまう）。
        hold_until_reap "$session" "$((event_at + HANDOFF_IDLE_SECONDS))" "$handoff_code" \
          "$handoff_hold"
        return 0
      fi
      reason="$handoff_reason"
    fi
  fi

  # --- 畳む ---
  reason="$reason・最後の応答終了から$((idle_for / 60))分・worktreeはcleanでpush済み"
  fold_session "$session" "$repository" "$issue_number" "$reason" \
    "もう一度作業する場合は、issue-deckの画面から起動し直してください。前回の会話の続きから再開します（worktree: $worktree）。"
  return 0
}

while IFS= read -r session_name; do
  [[ -n "$session_name" ]] || continue
  CHECKED=$((CHECKED + 1))
  reap_one "$session_name"
done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)

echo "セッションを確認しました: $CHECKED 件（回収対象 $CANDIDATES 件・畳んだ $REAPED 件・猶予 ${IDLE_MINUTES}分・引き渡し済み ${HANDOFF_IDLE_MINUTES}分・質問 ${QUESTION_IDLE_MINUTES}分）"
