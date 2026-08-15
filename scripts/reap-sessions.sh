#!/usr/bin/env bash
# 作業が終わった実装セッション（tmuxセッションと`claude`プロセス）を畳む（#1256）。
# #1223 の第0段階（孤児の開発サーバー回収）・第1段階（アイドルな開発サーバーの停止）に続く第2段階。
#
# 使い方:
#   scripts/reap-sessions.sh                    条件を満たすセッションを畳む
#   scripts/reap-sessions.sh --dry-run          判定だけ表示し、何も畳まない
#   scripts/reap-sessions.sh --idle-minutes 90  猶予（分）を指定する（0で回収を行わない）
#   scripts/reap-sessions.sh --handoff-idle-minutes 60   引き渡し済みの猶予を指定する
#
# 環境変数:
#   SESSION_IDLE_MINUTES          最後の`Stop`からこの分数が経つまで畳まない（既定60・0で無効）
#   SESSION_HANDOFF_IDLE_MINUTES  PRを作り`11.local`も外した（引き渡し済みの）セッション専用の
#                                 猶予（既定30・0でこの経路だけ無効。#1541）
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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 状態ファイルの置き場と読み書きは、書く側（run-issue-session.sh・session-notify.sh）と共有する。
# shellcheck source=scripts/lib/session-state.sh
source "$SCRIPT_DIR/lib/session-state.sh"

IDLE_MINUTES="${SESSION_IDLE_MINUTES:-60}"
# 引き渡し済み（PRを作り`11.local`も外した）セッション専用の猶予（#1541）。
# CLOSED／マージ済みは「もう何も起きない」が確定しているのに対し、引き渡し済みはCI失敗の
# 指摘が返る余地があるため、段差を付ける。0でこの経路だけを無効にできる。
HANDOFF_IDLE_MINUTES="${SESSION_HANDOFF_IDLE_MINUTES:-30}"
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
    *)
      echo "Usage: scripts/reap-sessions.sh [--dry-run] [--idle-minutes <分>] [--handoff-idle-minutes <分>]" >&2
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
reap_one() {
  local session="$1"
  local descriptor reapable worktree repository issue_number kind
  local alive_panes event_line event_at event_name idle_for
  local dirty remote_branches issue_info issue_state issue_labels merged_pr open_pr reason

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
  idle_for=$((NOW - event_at))
  if [[ "$idle_for" -lt "$IDLE_SECONDS" ]]; then
    # 経過時間は毎分変わるため、理由の文字列には入れない（入れると毎分ログへ出てしまう）。
    hold "$session" "最後の応答終了から猶予（${IDLE_MINUTES}分）が経っていない"
    return 0
  fi

  # --- 横断質問セッション（#1454）はここで決める ---
  # **worktreeを持たず、コミットもpushもしない**（読み取り専用で、成果物は質問Issueへ投稿した
  # 回答コメントだけ）。実装セッション向けの「worktreeがcleanでpush済み」を当てると必ず
  # 「確認できない」に落ちて永久に残るため、質問Issueが閉じられたかどうかだけで決める。
  if [[ "$kind" == "question" ]]; then
    if ! issue_state="$(gh issue view "$issue_number" --repo "$repository" \
      --json state --jq '.state' 2>/dev/null)"; then
      hold "$session" "質問Issueの状態を取得できない（$repository #$issue_number）"
      return 0
    fi
    if [[ "$issue_state" != "CLOSED" ]]; then
      # **開いている間は畳まない。** 追い質問はこのセッションへ追加指示として送れる（#1012）ので、
      # 聞き終わったかどうかを知っているのは人だけ。質問Issueを閉じることが終了の合図になる。
      hold "$session" "質問Issue #$issue_number がまだOPEN（閉じると畳みます）"
      return 0
    fi
    fold_session "$session" "$repository" "$issue_number" \
      "質問Issue #$issue_number はCLOSED・最後の応答終了から$((idle_for / 60))分" \
      "もう一度聞く場合は、issue-deckの「質問する」から起動し直してください。"
    return 0
  fi

  # --- 畳んだ後に取り返せないものが残っていないか ---
  if [[ ! -d "$worktree" ]]; then
    hold "$session" "worktreeが見つからない（$worktree）"
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

  # --- 作業が終わっているか（GitHub側の事実） ---
  # `11.local`はランチャーが起動時に付け、**実装エージェントが引き渡し時に自分で外す**ラベル
  # （scripts/prompts/implementation-agent.md）。付いている間はローカルで作業中なので畳まない。
  # 「巻き込んではいけないもの」であると同時に、ローカル作業の終了宣言そのものでもある。
  if ! issue_info="$(gh issue view "$issue_number" --repo "$repository" \
    --json state,labels --jq '.state, (.labels[].name)' 2>/dev/null)"; then
    hold "$session" "Issueの状態を取得できない（$repository #$issue_number）"
    return 0
  fi
  issue_state="$(printf '%s\n' "$issue_info" | head -1)"
  issue_labels="$(printf '%s\n' "$issue_info" | tail -n +2)"
  if printf '%s\n' "$issue_labels" | grep -Fxq "11.local"; then
    hold "$session" "11.local が付いている（ローカルで作業中）"
    return 0
  fi

  # 成果物が本流に入ったか、Issue自体が終わっているか。
  # **`22.merge-confirm-required`の特別扱いは要らない。** 人がマージするまでPRはopenのままなので、
  # マージ済みの経路では自動的に残る（ラベルを見る箇所を増やさない）。
  if [[ "$issue_state" == "CLOSED" ]]; then
    reason="Issue #$issue_number はCLOSED"
  else
    merged_pr="$(gh pr list --repo "$repository" --head "issue-$issue_number" --state merged \
      --json number --jq '.[0].number // empty' 2>/dev/null || true)"
    if [[ -n "$merged_pr" ]]; then
      reason="PR #$merged_pr がマージ済み"
    else
      # 引き渡し済み（#1541）。**PRを作り、`11.local`も外した**（条件5を通っている）＝
      # レビュー・統合エージェントへ渡し終えた状態で、このセッションでもう作業しないという
      # 実装エージェント自身の宣言にあたる。マージまで残すと、人の確認待ちのPRを抱えた
      # セッションが本数の上限（#1361）を埋めて、後続のジョブが流れなくなる。
      #
      # **畳んでも失うものは無い。** worktreeはcleanでpush済み（条件7）、worktreeそのものは
      # 残り、呼び戻せば前回の会話の続きから再開する（#1541・run-issue-session.sh の
      # `--continue`）。マージ済み・CLOSEDより猶予を長く取るのは、CI失敗の指摘が返る余地が
      # こちらにだけ残っているため。
      if [[ "$HANDOFF_IDLE_SECONDS" -eq 0 ]]; then
        hold "$session" "IssueがOPENで、issue-$issue_number のPRもまだマージされていない"
        return 0
      fi
      open_pr="$(gh pr list --repo "$repository" --head "issue-$issue_number" --state open \
        --json number --jq '.[0].number // empty' 2>/dev/null || true)"
      if [[ -z "$open_pr" ]]; then
        hold "$session" "IssueがOPENで、issue-$issue_number のPRがまだ作られていない"
        return 0
      fi
      if [[ "$idle_for" -lt "$HANDOFF_IDLE_SECONDS" ]]; then
        # 経過時間は毎分変わるため、理由の文字列には入れない（入れると毎分ログへ出てしまう）。
        hold "$session" "PR #$open_pr を引き渡してから猶予（${HANDOFF_IDLE_MINUTES}分）が経っていない"
        return 0
      fi
      reason="PR #$open_pr を作成しレビューへ引き渡し済み"
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

echo "セッションを確認しました: $CHECKED 件（回収対象 $CANDIDATES 件・畳んだ $REAPED 件・猶予 ${IDLE_MINUTES}分・引き渡し済み ${HANDOFF_IDLE_MINUTES}分）"
