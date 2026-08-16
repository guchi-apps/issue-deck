import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import type { DispatchSessionView } from "@/lib/dispatch/session-state";

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
    return {
      ...base,
      tone: "done",
      label: `${formatDispatchHostName(session.host)}のセッションは終了しました`,
      shortLabel: "終了",
      detail: null,
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

/** 一覧のバッジなど、1語で出したい場所向けの短い表現。通常の実行中はnull（出さない） */
export function shortIssueSessionLabel(session: DispatchSessionView): string | null {
  if (session.state === "FAILED") return "異常終了";
  if (session.state === "EXITED" || session.state === "GONE") return "終了";
  if (session.activity === "WAITING_INPUT") return "入力待ち";
  // 人が端末で答えるまで進まない点は入力待ちと同じなので、一覧にも出す（#1465）
  if (session.activity === "NOT_STARTED") return "未開始";
  return null;
}
