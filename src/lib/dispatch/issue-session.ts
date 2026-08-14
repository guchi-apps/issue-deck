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
      detail: null,
      remoteControlUrl: null,
      previewUrl: null,
    };
  }

  if (session.activity === "WAITING_INPUT") {
    return {
      ...base,
      at: session.activityAt ?? session.lastReportedAt,
      tone: "waiting",
      label: `${formatDispatchHostName(session.host)}のセッションが入力を待っています`,
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
      detail: "直前の入力に答えたあと、作業を続けています",
    };
  }
  if (session.activity === "RESPONDED") {
    return {
      ...base,
      at: session.activityAt ?? session.lastReportedAt,
      tone: "running",
      label: `${formatDispatchHostName(session.host)}のセッションは応答を終えています`,
      detail: "作業が終わっている場合と、次の指示を待っている場合があります",
    };
  }
  return {
    ...base,
    tone: "running",
    label: `${formatDispatchHostName(session.host)}で実行中`,
    detail: null,
  };
}

/** 一覧のバッジなど、1語で出したい場所向けの短い表現。通常の実行中はnull（出さない） */
export function shortIssueSessionLabel(session: DispatchSessionView): string | null {
  if (session.state === "FAILED") return "異常終了";
  if (session.state === "EXITED" || session.state === "GONE") return "終了";
  if (session.activity === "WAITING_INPUT") return "入力待ち";
  return null;
}
