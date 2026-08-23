import type { SessionQuestionRequestStatus } from "@prisma/client";

import { db } from "@/lib/db";
import {
  SESSION_QUESTION_DECIDED_VISIBLE_MS,
  SESSION_QUESTION_DECISION_STATUS,
  parseStoredSessionAnswers,
  parseStoredSessionQuestions,
  serializeSessionQuestions,
  toSessionQuestionRequestView,
  type SessionQuestion,
  type SessionQuestionDecision,
  type SessionQuestionDecisionRejection,
  type SessionQuestionRequestView,
} from "@/lib/dispatch/session-question-request";

/**
 * 質問への回答待ち（#2189）のうち、**DBに触る部分**。
 *
 * 値の検証・表示の判定は`session-question-request.ts`（画面のコンポーネントからもimportされるので
 * Prismaを引き込まない）。計画の承認待ちの`plan-requests.ts`と`session-plan-request.ts`の
 * 分け方に揃えている。
 */

/**
 * 回答待ちを1件作る。**同じIssueの古い待ちは畳む**（続けて質問したら前の待ちは無効）。
 *
 * 呼ぶのは`POST /api/dispatch/sessions/question`。
 */
export async function createSessionQuestionRequest(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string | null;
  questions: readonly SessionQuestion[];
  waitSeconds: number;
  now?: Date;
}): Promise<SessionQuestionRequestView> {
  const now = params.now ?? new Date();

  await db.sessionQuestionRequest.updateMany({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      status: "WAITING",
    },
    data: { status: "EXPIRED" },
  });

  const created = await db.sessionQuestionRequest.create({
    data: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      hostName: params.hostName,
      questions: serializeSessionQuestions(params.questions),
      expiresAt: new Date(now.getTime() + params.waitSeconds * 1000),
    },
  });
  return toSessionQuestionRequestView(created);
}

/** フックが受け取る結論 */
export type SessionQuestionOutcome = {
  status: SessionQuestionRequestStatus;
  /** `ANSWERED`のときだけ入る、`updatedInput.answers`へそのまま載せる値 */
  answers: Record<string, string> | null;
};

/**
 * フックが1回分ポーリングする。まだ決まっていなければ`WAITING`を返す。
 *
 * **待ち時間を過ぎていたらここで`EXPIRED`へ倒す。** 時計を持つのはサーバー側1か所にして、
 * フックとサーバーで期限の判断がずれないようにする。
 */
export async function pollSessionQuestionRequest(
  id: string,
  now: Date = new Date(),
): Promise<SessionQuestionOutcome | null> {
  const row = await db.sessionQuestionRequest.findUnique({ where: { id } });
  if (!row) return null;

  if (row.status === "WAITING") {
    if (row.expiresAt.getTime() > now.getTime()) {
      return { status: "WAITING", answers: null };
    }
    await db.sessionQuestionRequest.updateMany({
      where: { id, status: "WAITING" },
      data: { status: "EXPIRED", deliveredAt: now },
    });
    return { status: "EXPIRED", answers: null };
  }

  // 決まっていた。**受け取ったことを残す**（画面が「もう届いた」と出せるようにする）
  if (row.deliveredAt === null) {
    await db.sessionQuestionRequest.update({ where: { id }, data: { deliveredAt: now } });
  }
  return { status: row.status, answers: parseStoredSessionAnswers(row.answers) };
}

/**
 * セッションが待つのをやめたことを書き込み、**そのうえで最後にもう一度結論を返す**（#2108と同じ）。
 *
 * 呼ぶのは`scripts/session-notify.sh`——issue-deckへ届かない状態が続いて待ちを降りるとき。
 * 伝えないと画面は待ち時間いっぱい「回答を待っています」を出し続け、**押しても誰も
 * 受け取らないボタン**が残る。
 *
 * 畳むのは`WAITING`のときだけなので、降りると決める直前に押されていればその結論が返り、
 * フックはそれを回答として使える（降りるかどうかの最後の確認を兼ねる）。
 */
export async function releaseSessionQuestionRequest(
  id: string,
  now: Date = new Date(),
): Promise<SessionQuestionOutcome | null> {
  await db.sessionQuestionRequest.updateMany({
    where: { id, status: "WAITING" },
    data: { status: "DEFERRED", decidedAt: now, deliveredAt: now },
  });
  return pollSessionQuestionRequest(id, now);
}

/**
 * 画面から押した結果を書き込む。**`WAITING`のときだけ通す**（1回で確定する）。
 *
 * 判定と書き込みを`updateMany`の`where`で同時に行い、同時に押された・待ち時間ちょうどに
 * 押された場合でも二重に決まらないようにする。
 *
 * **回答の突き合わせは呼び出し側で終わっている**（保存してある質問と照らして
 * `buildSessionQuestionAnswers`が作った値だけがここへ来る）。
 */
export async function decideSessionQuestionRequest(params: {
  id: string;
  decision: SessionQuestionDecision;
  answers: Record<string, string> | null;
  decidedByUserId: string;
  now?: Date;
}): Promise<
  | { ok: true; request: SessionQuestionRequestView }
  | { ok: false; rejection: SessionQuestionDecisionRejection }
> {
  const now = params.now ?? new Date();

  const updated = await db.sessionQuestionRequest.updateMany({
    where: { id: params.id, status: "WAITING", expiresAt: { gt: now } },
    data: {
      status: SESSION_QUESTION_DECISION_STATUS[params.decision],
      answers:
        params.decision === "answer" && params.answers ? JSON.stringify(params.answers) : null,
      decidedByUserId: params.decidedByUserId,
      decidedAt: now,
    },
  });

  const row = await db.sessionQuestionRequest.findUnique({ where: { id: params.id } });
  if (updated.count === 0) {
    if (!row) return { ok: false, rejection: "not_found" };
    if (row.status !== "WAITING") return { ok: false, rejection: "already_decided" };
    return { ok: false, rejection: "expired" };
  }
  // 直前に書けているので普通は引ける。引けないならもう存在しない
  if (!row) return { ok: false, rejection: "not_found" };
  return { ok: true, request: toSessionQuestionRequestView(row) };
}

/**
 * 決める前の質問だけを読み出す（回答の突き合わせに使う）。
 *
 * **画面から届いたラベルを検証する相手はDBに入っている質問**で、画面が送ってきた質問文では
 * ない。見つからない・読めない場合は`null`。
 */
export async function findSessionQuestionRequestQuestions(
  id: string,
): Promise<SessionQuestion[] | null> {
  const row = await db.sessionQuestionRequest.findUnique({ where: { id } });
  if (!row) return null;
  const questions = parseStoredSessionQuestions(row.questions);
  return questions.length > 0 ? questions : null;
}

/**
 * 画面が読む一覧。**待っているものと、決まった直後のものだけ**を返す。
 *
 * ついでに期限切れを掃除する（`listSessionPlanRequests`と同じ方針で、常駐プロセスは置かない）。
 * フックが落ちた・セッションごと消えた場合、誰も`pollSessionQuestionRequest`を呼ばないため、
 * ここで倒さないと画面に「回答を待っています」が待ち時間いっぱい残る。
 */
export async function listSessionQuestionRequests(
  now: Date = new Date(),
): Promise<SessionQuestionRequestView[]> {
  await db.sessionQuestionRequest.updateMany({
    where: { status: "WAITING", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });

  const rows = await db.sessionQuestionRequest.findMany({
    where: {
      OR: [
        { status: "WAITING" },
        { decidedAt: { gte: new Date(now.getTime() - SESSION_QUESTION_DECIDED_VISIBLE_MS) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(toSessionQuestionRequestView);
}
