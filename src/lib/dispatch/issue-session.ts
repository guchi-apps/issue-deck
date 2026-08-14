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
  /** 補足（終了コード等）。無ければnull */
  detail: string | null;
  /** スマホから答えるための出口。取れていなければnull */
  remoteControlUrl: string | null;
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
 * （もう一方の担保は`Stop`フックによる`RESPONDED`への遷移）。
 */
export function summarizeIssueSession(session: DispatchSessionView): IssueSessionSummary {
  const base = { session, remoteControlUrl: session.remoteControlUrl };

  if (session.state === "FAILED") {
    return {
      ...base,
      tone: "error",
      label: `${session.host}のセッションが異常終了しました`,
      detail: session.exitStatus === null ? null : `終了コード ${session.exitStatus}`,
      // 落ちたセッションのRemote Controlは開いても意味が無い
      remoteControlUrl: null,
    };
  }
  if (session.state === "EXITED" || session.state === "GONE") {
    return {
      ...base,
      tone: "done",
      label: `${session.host}のセッションは終了しました`,
      detail: null,
      remoteControlUrl: null,
    };
  }

  if (session.activity === "WAITING_INPUT") {
    return {
      ...base,
      tone: "waiting",
      label: `${session.host}のセッションが入力を待っています`,
      detail: "承認プロンプトか質問で止まっています。Remote Controlから答えてください",
    };
  }
  if (session.activity === "RESPONDED") {
    return {
      ...base,
      tone: "running",
      label: `${session.host}のセッションは応答を終えています`,
      detail: "作業が終わっている場合と、次の指示を待っている場合があります",
    };
  }
  return {
    ...base,
    tone: "running",
    label: `${session.host}で実行中`,
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
