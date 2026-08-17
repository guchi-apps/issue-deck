import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import type {
  DispatchSessionReapReason,
  DispatchSessionView,
} from "@/lib/dispatch/session-state";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";

/**
 * あるIssueに紐づくセッションを1件選び、画面へ出す形にする（#1264）。
 *
 * `DispatchJob`の寿命は「tmuxセッションが立った」ところで終わっているため、**起動したあとに
 * 何が起きているかは`DispatchSession`しか知らない**。APIは以前から返していたが画面に出して
 * いなかった（`docs/multi-agent/session-notify.md`が「実運用で必要になったら設計する」と
 * 留保していた箇所）。
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる。
 */

/** 画面に出すセッションの様子。状態（tmux）と様子（フック）を1つに畳んだもの */
export type IssueSessionTone = "running" | "waiting" | "done" | "error";

export type IssueSessionSummary = {
  session: DispatchSessionView;
  tone: IssueSessionTone;
  /** 見出しの文言 */
  label: string;
  /**
   * ホスト名を含まない短い言い方（#1567）。**`label`と同じ分岐で作る。**
   *
   * ホストのセッション一覧（`dispatch-host-panel.tsx`）のように、既にホスト名が見出しに
   * 出ている場所で使う。別の関数として持つと、状態が増えたときに片方だけ更新されて
   * 同じ状態が2通りの言い方で出る。
   */
  shortLabel: string;
  /**
   * 見出しに添える時刻（ISO文字列）。**その文言が何時のことなのかを指す**（#1353）。
   *
   * 入力待ち・応答終了はフックが報告してきた時刻（`activityAt`）で、それ以外はpollerが
   * 最後に見た時刻（`lastReportedAt`）。pollerは1巡ごとに`lastReportedAt`を更新するので、
   * こちらを入力待ちに添えると**何時間前の入力待ちでも「たった今」と出る**。
   */
  at: string;
  /** 補足（終了コード等）。無ければnull */
  detail: string | null;
  /** スマホから答えるための出口。取れていなければnull */
  remoteControlUrl: string | null;
  /** tailnetへ出した開発サーバー（#1265）。**生きているセッションでだけ出す** */
  previewUrl: string | null;
};

/**
 * そのIssueのセッションを1件選ぶ。**生きているものを最優先**し、無ければ直近に報告のあったもの。
 * 終わったセッションも出すのは、「さっきまで動いていたものが終わった」ことを画面から分かる
 * ようにするため（`DispatchJob`の終了済みジョブを出しているのと同じ理由）。
 */
export function findSessionForIssue(
  sessions: readonly DispatchSessionView[],
  repositoryFullName: string,
  issueNumber: number,
): DispatchSessionView | null {
  const mine = sessions.filter(
    (session) =>
      session.repositoryFullName === repositoryFullName && session.issueNumber === issueNumber,
  );
  if (mine.length === 0) return null;
  const alive = mine.find((session) => session.state === "ALIVE");
  if (alive) return alive;
  return [...mine].sort((a, b) => b.lastReportedAt.localeCompare(a.lastReportedAt))[0];
}

/**
 * 状態（poller＝tmuxのメタデータ）と様子（フック）を1つの表示へ畳む。
 *
 * **`WAITING_INPUT`が意味を持つのは`ALIVE`の間だけ。** セッションが落ちれば入力を待つ相手が
 * いないので、状態の方を優先する。これが「古い入力待ちが残り続けない」ことの担保になっている
 * （残りの担保は`PostToolUse`フックによる`WORKING`への遷移＝#1357と、`Stop`フックによる
 * `RESPONDED`への遷移）。
 */
export function summarizeIssueSession(session: DispatchSessionView): IssueSessionSummary {
  const base = {
    session,
    at: session.lastReportedAt,
    remoteControlUrl: session.remoteControlUrl,
    // セッションが終われば`tailscale serve`も撤去されている（cleanupとpollerの回収）。
    // 開いても繋がらないURLを残さない
    previewUrl: session.state === "ALIVE" ? session.previewUrl : null,
  };

  if (session.state === "FAILED") {
    return {
      ...base,
      tone: "error",
      label: `${formatDispatchHostName(session.host)}のセッションが異常終了しました`,
      shortLabel: "異常終了",
      detail: session.exitStatus === null ? null : `終了コード ${session.exitStatus}`,
      // 落ちたセッションのRemote Controlは開いても意味が無い
      remoteControlUrl: null,
      previewUrl: null,
    };
  }
  if (session.state === "EXITED" || session.state === "GONE") {
    // **回答を待ったまま消えた場合だけは別の言い方をする**（#1830）。どちらも「終了しました」と
    // 出すと、役目を終えて自動で畳まれたのか（次に押すものは無い）、こちらの回答を待ったまま
    // 消えたのか（復旧して答える必要がある）を区別できない。
    //
    // **`state`を優先するという方針は変えていない。** `WAITING_INPUT`をここで「今も待っている」
    // 意味には使わず（待つ相手はもういない）、**終わり方の記録**としてだけ読む。答えた後に
    // 作業が進めば`WORKING`／`RESPONDED`へ移るため、終了時点で`WAITING_INPUT`のまま残るのは
    // 実際に答えないうちに消えた場合に限られる。
    const endedWhileWaiting = session.activity === "WAITING_INPUT";
    return {
      ...base,
      tone: endedWhileWaiting ? "waiting" : "done",
      label: endedWhileWaiting
        ? `${formatDispatchHostName(session.host)}のセッションは回答を待っている間に終了しました`
        : `${formatDispatchHostName(session.host)}のセッションは終了しました`,
      shortLabel: endedWhileWaiting ? "回答前に終了" : "終了",
      // 復旧すると会話の続きから始まることは、押す場所（`SessionRecoveryButton`）の側に添える。
      // 両方で言うと同じ案内が2行並ぶ
      detail: endedWhileWaiting ? "あなたの回答を待っている間にセッションが終了しました" : null,
      remoteControlUrl: null,
      previewUrl: null,
    };
  }

  // Claude Code本体がまだ開始していない（#1465）。**`WAITING_INPUT`と混ぜない。**
  // 混ぜると「Remote Controlから答えてください」と出るが、セッションが始まっていない以上
  // Remote Controlは繋がっておらず、画面から辿れる出口がその1つだけになる。
  if (session.activity === "NOT_STARTED") {
    return {
      ...base,
      at: session.activityAt ?? session.lastReportedAt,
      tone: "waiting",
      label: `${formatDispatchHostName(session.host)}のセッションがまだ開始していません`,
      shortLabel: "まだ開始していません",
      detail: `フォルダの信頼確認（Is this a project you created or one you trust?）などで止まっている可能性があります。\`tmux attach -t ${session.tmuxSessionName}\`で答えてください`,
      // 繋がっていないURLを出さない（起動時に取れた値が残っていることがある）
      remoteControlUrl: null,
    };
  }
  if (session.activity === "WAITING_INPUT") {
    return {
      ...base,
      at: session.activityAt ?? session.lastReportedAt,
      tone: "waiting",
      label: `${formatDispatchHostName(session.host)}のセッションが入力を待っています`,
      shortLabel: "入力を待っています",
      detail: "承認プロンプトか質問で止まっています。Remote Controlから答えてください",
    };
  }
  // 承認プロンプトに答えて作業へ戻った直後（#1357）。**`RESPONDED`と混ぜない。**
  // 混ぜると「応答を終えています」と出て、実際には走っているセッションを終わったように見せる。
  if (session.activity === "WORKING") {
    return {
      ...base,
      at: session.activityAt ?? session.lastReportedAt,
      tone: "running",
      label: `${formatDispatchHostName(session.host)}のセッションが作業中です`,
      shortLabel: "作業中",
      detail: "直前の入力に答えたあと、作業を続けています",
    };
  }
  if (session.activity === "RESPONDED") {
    return {
      ...base,
      at: session.activityAt ?? session.lastReportedAt,
      tone: "running",
      label: `${formatDispatchHostName(session.host)}のセッションは応答を終えています`,
      shortLabel: "応答を終えています",
      detail: "作業が終わっている場合と、次の指示を待っている場合があります",
    };
  }
  return {
    ...base,
    tone: "running",
    label: `${formatDispatchHostName(session.host)}で実行中`,
    shortLabel: "実行中",
    detail: null,
  };
}

/**
 * そのセッションが今まさに人の入力を待って止まっているか（#1417）。
 *
 * 承認欄のボタンを引っ込めてRemote Controlへ寄せる判断に使う。**`ALIVE`でなければfalse**。
 * 落ちたセッションの`WAITING_INPUT`は待つ相手がいない古い値で、そのときまでボタンを消すと
 * 画面から`00.check-user`を外す手段が無くなる（`summarizeIssueSession`が状態を優先するのと同じ理由）。
 */
export function isSessionWaitingInput(session: DispatchSessionView | null): boolean {
  if (!session) return false;
  return session.state === "ALIVE" && session.activity === "WAITING_INPUT";
}

/**
 * 1行に畳んだセッション行の文言（#1676）。例:「サブPC・まだ開始していません」。
 *
 * **`summarizeIssueSession`の`shortLabel`にホスト名を添えるだけ**で、状態の分岐をここに増やさない。
 * 別々に分岐を持つと、状態が増えたときに片方だけ更新されて同じ状態が2通りの言い方で出る
 * （`shortLabel`を`label`と同じ分岐で作っているのと同じ理由）。
 *
 * 使う場所は、起動ジョブの行（「サブPCで起動しました」）をこの行へ畳んだとき。畳む前は
 * 同じ「サブPCで動いている」ことを2行で言っていた。
 */
export function compactIssueSessionLabel(session: DispatchSessionView): string {
  const summary = summarizeIssueSession(session);
  return `${formatDispatchHostName(session.host)}・${summary.shortLabel}`;
}

/**
 * 自動終了までの残り時間の表示（#1817）。
 *
 * サブPCの`scripts/reap-sessions.sh`は、条件をすべて満たしたセッションを猶予（既定5分）の後に
 * `tmux kill-session`で畳む。**その猶予を待っている間、画面には「応答を終えています」としか
 * 出ておらず、このまま消えるのか残るのかが読み取れなかった。**
 *
 * **判定はここでやり直さない。** 畳む条件にはworktreeがcleanか・コミットがpush済みかという
 * サブPCのファイルシステムにしか無い事実が含まれ、画面側では同じ判定を組み立てられない。
 * 組み立てようとすると必ずずれ、**終わらないセッションに終了予告が出る**。ここは運ばれてきた
 * 予定（`reapAt`・`reapReason`）を言い方に直すだけ。
 */
export type SessionReapNotice = {
  /** ピル・一覧行に出す短い言い方。例:「あと3分で自動終了」 */
  label: string;
  /** なぜ終わるのか・畳まれた後どうなるか。1行で添える */
  detail: string;
  /** 期限まで1分を切っている（次の巡で畳まれる）か */
  imminent: boolean;
};

/** 理由コード（`reap-sessions.sh`が判定した経路）から、画面の言い方へ */
const REAP_REASON_TEXT: Record<DispatchSessionReapReason, string> = {
  ISSUE_CLOSED: "Issueがcloseされているため",
  PR_MERGED: "PRがマージ済みのため",
  HANDOFF_PR_OPEN: "PRを作成しレビューへ引き渡し済みのため",
  HANDOFF_NO_PR: "PRを作らずにローカル作業を終えているため",
  QUESTION_CLOSED: "質問Issueがcloseされているため",
  QUESTION_IDLE: "質問セッションが放置されているため",
};

/**
 * 横断質問セッション（#1454）は畳まれても会話を引き継がない（cwdが質問Issue間で共有される
 * ため`--continue`が別の質問を拾う。#1648）。**実装セッションと同じ案内を出さない。**
 */
const QUESTION_REAP_REASONS = new Set<DispatchSessionReapReason>(["QUESTION_CLOSED", "QUESTION_IDLE"]);

/**
 * 期限を過ぎた予定を出し続けない上限（ミリ秒）。
 *
 * 期限が来れば次の巡（既定30秒）で畳まれるが、回収を止めている（`SESSION_IDLE_MINUTES=0`）・
 * pollerが古い・落ちている場合は畳まれないまま予定だけが残る。**そのときに「まもなく自動終了」を
 * 出し続けると、いつまでも終わらない終了予告になる**ので、少し過ぎたら黙る。
 */
const REAP_NOTICE_STALE_MS = 2 * 60 * 1000;

export function describeSessionReap(
  session: DispatchSessionView,
  now: Date = new Date(),
): SessionReapNotice | null {
  // 終わったセッションに終了予告を出さない（`summarizeIssueSession`が状態を優先するのと同じ理由）
  if (session.state !== "ALIVE") return null;
  // **時刻と理由が揃っているときだけ出す。** 理由の無い終了予告は、勝手に消されるとしか読めない
  if (!session.reapAt || !session.reapReason) return null;

  const deadline = new Date(session.reapAt).getTime();
  if (Number.isNaN(deadline)) return null;
  const remainingMs = deadline - now.getTime();
  if (remainingMs < -REAP_NOTICE_STALE_MS) return null;

  // 切り捨て。残り3分10秒を「あと4分」と出すより、早めに言う方が実際の畳まれ方に近い
  // （pollerの巡は最大30秒遅れるため、期限ちょうどには畳まれない）
  const minutes = Math.floor(remainingMs / 60_000);
  const imminent = minutes < 1;
  const suffix = QUESTION_REAP_REASONS.has(session.reapReason)
    ? "、このまま操作が無ければ自動で終了します。続きを聞くときは「質問する」から新しく質問してください（畳んだセッションの会話は引き継ぎません）。"
    : "、このまま操作が無ければ自動で終了します。worktreeは残るので、次に起動すると前回の続きから再開します。";

  return {
    label: imminent ? "まもなく自動終了" : `あと${minutes}分で自動終了`,
    detail: `${REAP_REASON_TEXT[session.reapReason]}${suffix}`,
    imminent,
  };
}

/**
 * 終了したセッションを画面から復旧できるか（#1830）。
 *
 * **復旧の実体は「同じIssueで起動ジョブをもう一度積む」だけ。** worktreeを消していなければ
 * ランチャーが`claude --continue`を渡し、前回の会話の続きから再開する（#1541。
 * `scripts/run-issue-session.sh`）。issue-deck側はsession idもホストの内部状態も持たない。
 *
 * ここが返すのは**押せる相手がいるかどうか**（＝セッションがもう動いていないか）だけで、
 * 「サブPCが申告しているか」「未処理のジョブがあるか」は起動ジョブと同じ判定
 * （`resolveDispatchTargetRejection`）に任せる。判定を二重に持つと、押せる条件が場所によって
 * ずれる。
 */
export type SessionRecoveryNotice = {
  /** 主導線（塗りつぶし）で出すか。回答を待ったまま終わったときだけ真 */
  primary: boolean;
  /** ボタンに常に添える1行。押すと何が起きるかを、押す前に読ませる */
  detail: string;
};

export function describeSessionRecovery(session: DispatchSessionView): SessionRecoveryNotice | null {
  // 動いているセッションには復旧する相手がいない（止めたい・送りたいは既存の操作の担当）
  if (session.state === "ALIVE") return null;
  return {
    primary: session.activity === "WAITING_INPUT",
    detail: `${formatDispatchHostName(session.host)}で前回の会話の続きから再開します（worktreeはそのまま・${LOCAL_LABEL_NAME}を付け直します）`,
  };
}

/** 一覧のバッジなど、1語で出したい場所向けの短い表現。通常の実行中はnull（出さない） */
export function shortIssueSessionLabel(session: DispatchSessionView): string | null {
  if (session.state === "FAILED") return "異常終了";
  // 終了の言い分けは`summarizeIssueSession`と同じ分岐にする（#1830）。片方だけ増やすと、
  // 同じ状態が一覧とIssue詳細で2通りの言い方になる
  if (session.state === "EXITED" || session.state === "GONE") {
    return session.activity === "WAITING_INPUT" ? "回答前に終了" : "終了";
  }
  if (session.activity === "WAITING_INPUT") return "入力待ち";
  // 人が端末で答えるまで進まない点は入力待ちと同じなので、一覧にも出す（#1465）
  if (session.activity === "NOT_STARTED") return "未開始";
  return null;
}
