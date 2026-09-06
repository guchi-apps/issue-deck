import { db } from "@/lib/db";
import { decideSessionPlanRequest } from "@/lib/dispatch/plan-requests";
import { decideSessionQuestionRequest } from "@/lib/dispatch/question-requests";

/**
 * 質問・計画の返事を、issue-deckの画面ではなく**Claude Codeアプリ（端末）側で受け取る**
 * 切り替え（#2822）。
 *
 * #2061（計画）・#2189（質問）で、フックが待ちを作って画面から答えられるようにした。その
 * 副作用として、**待っている間はClaude Codeアプリに選択フォームも承認プロンプトも出ない**
 * （フックが返ってからしか出ないため）。手作業Issueのセッション（#2771）をアプリ側で
 * そのまま進めたい場面では、これが「アプリに何も出てこない」として出る。
 *
 * そこで**セッション1本ごとのトグル**を置き、ONのあいだは受け口（`/sessions/question`・
 * `/sessions/plan`）が待ちを作らない。フックは何も出力せずに終え、Claude Codeが端末へ
 * 出したフォームがそのままRemote Control（Claude Codeアプリ）にも見える。
 *
 * **変えるのは「どこで答えるか」だけ。** Issueコメント（計画本文）・`00.check-user`・
 * Push通知は従来どおり出す——記録と気付ける経路まで一緒に消すと、答え先が変わっただけの
 * はずが「何も起きていない」ように見える。
 *
 * **全体設定（`AppSetting`）にはしない。** 別のIssueをスマホから答える経路まで一緒に
 * 切ってしまうため、効くのは切り替えたセッションだけにする。
 *
 * 値の読み書きだけをここに置き、画面へ返す形（`DispatchSessionView.answerInApp`）は
 * `session-state.ts`が持つ。
 */

/** 画面から届いた切り替えの値。真偽値以外は受け付けない（既定へ倒すと押した向きが消える） */
export function parseSessionAnswerInApp(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export type SessionAnswerModeRejection = "not_found" | "not_alive" | "codex";

export function describeSessionAnswerModeRejection(
  rejection: SessionAnswerModeRejection,
): string {
  switch (rejection) {
    case "not_found":
      return "セッションの記録が見つかりません（畳まれた可能性があります）。";
    case "not_alive":
      return "このセッションは終了しています。起動し直してから切り替えてください。";
    case "codex":
      return "Codexのセッションでは切り替えられません（Claude Codeアプリに相当する出口がありません）。";
  }
}

/**
 * トグルを書き込む。**生きている（`ALIVE`）セッションにだけ効く。**
 *
 * 終わったセッションに書いても、次に同じ名前で立ち上がった行では捨てられる
 * （`isRevivedSession`）ので、押せたのに効かないものを作らないためここで断る。
 */
export async function setSessionAnswerInApp(params: {
  host: string;
  tmuxSessionName: string;
  answerInApp: boolean;
}): Promise<{ ok: true } | { ok: false; rejection: SessionAnswerModeRejection }> {
  const row = await db.dispatchSession.findUnique({
    where: {
      host_tmuxSessionName: { host: params.host, tmuxSessionName: params.tmuxSessionName },
    },
    select: { state: true, codexThreadKnown: true },
  });
  if (!row) return { ok: false, rejection: "not_found" };
  if (row.state !== "ALIVE") return { ok: false, rejection: "not_alive" };
  // **Codexのセッションでは断る**（計画レビューの指摘1）。**画面で出し分けるだけにしない。**
  // Codexの質問も同じ受け口（`/sessions/question`）へ登録し、`questionRequestId`が返らないと
  // `scripts/submit-question.sh`は終了コード3で「端末での確認へ」倒れる。ところがCodexには
  // `remoteControlUrl`が無い（出るのは10分で切れるペアリングコードだけ。#2524）ので、
  // ONにすると**画面からもアプリからも答えられない質問**ができる。
  // 判定は画面と同じ「`codexThreadKnown`が`null`ならClaude Code」
  if (row.codexThreadKnown !== null) return { ok: false, rejection: "codex" };

  await db.dispatchSession.update({
    where: {
      host_tmuxSessionName: { host: params.host, tmuxSessionName: params.tmuxSessionName },
    },
    data: { answerInApp: params.answerInApp },
  });
  return { ok: true };
}

/**
 * セッションの起動時にOFFへ戻す（計画レビューの指摘2）。**`POST /api/dispatch/sessions/started`
 * から、`claude`が立つ直前に1回だけ呼ぶ。**
 *
 * `isRevivedSession`（`sessions.ts`）の破棄では間に合わない。あちらが動くのは**pollerが次に
 * 一括報告した時**（既定60秒ごと）で、しかも`ALIVE`のまま立ち上がり直した行では
 * `ALIVE` → `ALIVE`になるため一度も動かない。手作業セッションは起動から数秒で
 * `AskUserQuestion`を出す（コマンドを実行する前に必ず全文を示して聞く）ので、前のセッションの
 * ONがそのまま効いて**画面に回答パネルが出ない**。
 *
 * **`updateMany`で、行が無くても静かに終える。** 起動報告は行の有無と無関係に成立させる
 * 受け口で（受付コメントと同じ）、ここで落とすと受付コメントごと落ちる。
 */
export async function resetSessionAnswerInApp(params: {
  host: string;
  tmuxSessionName: string;
}): Promise<void> {
  await db.dispatchSession.updateMany({
    where: { host: params.host, tmuxSessionName: params.tmuxSessionName },
    data: { answerInApp: false },
  });
}

/**
 * この質問・計画をアプリ側へ降ろすか。**受け口（フック）から呼ぶ。**
 *
 * 引くのは**そのIssueで生きているセッション**で、`hostName`が分かっていれば絞る。
 * **行が無ければ`false`**（＝従来どおり画面で受け取る）。pollerが1巡する前に質問が出ると
 * 行がまだ無いが、そのときは既定の動きになるだけで詰まらない。
 */
export async function isSessionAnswerInApp(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string | null;
}): Promise<boolean> {
  const row = await db.dispatchSession.findFirst({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      state: "ALIVE",
      ...(params.hostName ? { host: params.hostName } : {}),
    },
    orderBy: { lastReportedAt: "desc" },
    select: { answerInApp: true },
  });
  return row?.answerInApp === true;
}

/**
 * ONへ切り替えたときに、**いま画面で待っている計画・質問をその場で畳む**（#2822）。
 *
 * 畳まないと、押した本人の目の前に「押しても行き先が変わらないパネル」が待ち時間いっぱい
 * 残る。畳めばフックは`DEFERRED`を読んで待ちを降り、同じ質問がClaude Codeアプリ／端末へ出る
 * ——画面の「端末・Remote Controlで答える」を押したのと同じ結末で、経路も同じものを使う。
 *
 * **失敗しても切り替えは成功として扱う。** 決まった直後・期限切れに当たっただけのことが
 * 普通に起きるうえ、そのときは待ちがもう無いので目的は達している。
 */
export async function deferPendingSessionRequests(params: {
  repositoryFullName: string;
  issueNumber: number;
  decidedByUserId: string;
  now?: Date;
}): Promise<{ plan: boolean; question: boolean }> {
  const now = params.now ?? new Date();
  const where = {
    repositoryFullName: params.repositoryFullName,
    issueNumber: params.issueNumber,
    status: "WAITING" as const,
    expiresAt: { gt: now },
  };

  const [planRow, questionRow] = await Promise.all([
    db.sessionPlanRequest.findFirst({ where, orderBy: { createdAt: "desc" }, select: { id: true } }),
    db.sessionQuestionRequest.findFirst({
      where,
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
  ]);

  let plan = false;
  let question = false;
  if (planRow) {
    const decided = await decideSessionPlanRequest({
      id: planRow.id,
      decision: "defer",
      revisionText: null,
      decidedByUserId: params.decidedByUserId,
      now,
    });
    plan = decided.ok;
  }
  if (questionRow) {
    const decided = await decideSessionQuestionRequest({
      id: questionRow.id,
      decision: "defer",
      answers: null,
      decidedByUserId: params.decidedByUserId,
      now,
    });
    question = decided.ok;
  }
  return { plan, question };
}
