import type { SessionPlanRequestStatus } from "@prisma/client";

import { db } from "@/lib/db";
import {
  SESSION_PLAN_DECIDED_VISIBLE_MS,
  SESSION_PLAN_DECISION_STATUS,
  toSessionPlanRequestView,
  truncatePlanForPanel,
  type SessionPlanDecision,
  type SessionPlanDecisionRejection,
  type SessionPlanRequestView,
} from "@/lib/dispatch/session-plan-request";

/**
 * 計画への返事待ち（#2061）のうち、**DBに触る部分**。
 *
 * 値の検証・表示の判定は`session-plan-request.ts`（画面のコンポーネントからもimportされるので
 * Prismaを引き込まない）。`dispatch-job.ts`と`jobs.ts`の分け方に揃えている。
 */

/**
 * 返事待ちを1件作る。**同じIssueの古い待ちは畳む**（計画を出し直したら前の待ちは無効）。
 *
 * 呼ぶのは`POST /api/dispatch/sessions/plan`で、**計画コメントを実際に投稿できたときだけ**。
 * 投稿できていない＝画面に計画が出ないので、待たせても押す材料が無い。
 */
export async function createSessionPlanRequest(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string | null;
  plan: string;
  waitSeconds: number;
  now?: Date;
}): Promise<SessionPlanRequestView> {
  const now = params.now ?? new Date();

  await db.sessionPlanRequest.updateMany({
    where: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      status: "WAITING",
    },
    data: { status: "EXPIRED" },
  });

  const created = await db.sessionPlanRequest.create({
    data: {
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      hostName: params.hostName,
      plan: truncatePlanForPanel(params.plan),
      expiresAt: new Date(now.getTime() + params.waitSeconds * 1000),
    },
  });
  return toSessionPlanRequestView(created);
}

/** フックが受け取る結論 */
export type SessionPlanOutcome = {
  status: SessionPlanRequestStatus;
  /** `REVISION_REQUESTED`のときだけ入る、Claudeへ渡す文章 */
  revisionText: string | null;
};

/**
 * フックが1回分ポーリングする。まだ決まっていなければ`WAITING`を返す。
 *
 * **待ち時間を過ぎていたらここで`EXPIRED`へ倒す。** 時計を持つのはサーバー側1か所にして、
 * フックとサーバーで期限の判断がずれないようにする。
 */
export async function pollSessionPlanRequest(
  id: string,
  now: Date = new Date(),
): Promise<SessionPlanOutcome | null> {
  const row = await db.sessionPlanRequest.findUnique({ where: { id } });
  if (!row) return null;

  if (row.status === "WAITING") {
    if (row.expiresAt.getTime() > now.getTime()) {
      return { status: "WAITING", revisionText: null };
    }
    await db.sessionPlanRequest.updateMany({
      where: { id, status: "WAITING" },
      data: { status: "EXPIRED", deliveredAt: now },
    });
    return { status: "EXPIRED", revisionText: null };
  }

  // 決まっていた。**受け取ったことを残す**（画面が「もう届いた」と出せるようにする）
  if (row.deliveredAt === null) {
    await db.sessionPlanRequest.update({ where: { id }, data: { deliveredAt: now } });
  }
  return { status: row.status, revisionText: row.revisionText };
}

/**
 * 画面から押した結果を書き込む。**`WAITING`のときだけ通す**（1回で確定する）。
 *
 * 判定と書き込みを`updateMany`の`where`で同時に行い、同時に押された・待ち時間ちょうどに
 * 押された場合でも二重に決まらないようにする。
 */
export async function decideSessionPlanRequest(params: {
  id: string;
  decision: SessionPlanDecision;
  revisionText: string | null;
  decidedByUserId: string;
  now?: Date;
}): Promise<
  { ok: true; request: SessionPlanRequestView } | { ok: false; rejection: SessionPlanDecisionRejection }
> {
  const now = params.now ?? new Date();

  const updated = await db.sessionPlanRequest.updateMany({
    where: { id: params.id, status: "WAITING", expiresAt: { gt: now } },
    data: {
      status: SESSION_PLAN_DECISION_STATUS[params.decision],
      revisionText: params.decision === "revise" ? params.revisionText : null,
      decidedByUserId: params.decidedByUserId,
      decidedAt: now,
    },
  });

  const row = await db.sessionPlanRequest.findUnique({ where: { id: params.id } });
  if (updated.count === 0) {
    if (!row) return { ok: false, rejection: "not_found" };
    if (row.status !== "WAITING") return { ok: false, rejection: "already_decided" };
    return { ok: false, rejection: "expired" };
  }
  // 直前に書けているので普通は引ける。引けないならもう存在しない
  if (!row) return { ok: false, rejection: "not_found" };
  return { ok: true, request: toSessionPlanRequestView(row) };
}

/**
 * 画面が読む一覧。**待っているものと、決まった直後のものだけ**を返す。
 *
 * ついでに期限切れを掃除する（`expireStaleDispatchJobs`と同じ方針で、常駐プロセスは置かない）。
 * フックが落ちた・セッションごと消えた場合、誰も`pollSessionPlanRequest`を呼ばないため、
 * ここで倒さないと画面に「承認を待っています」が待ち時間いっぱい残る。
 */
export async function listSessionPlanRequests(
  now: Date = new Date(),
): Promise<SessionPlanRequestView[]> {
  await db.sessionPlanRequest.updateMany({
    where: { status: "WAITING", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });

  const rows = await db.sessionPlanRequest.findMany({
    where: {
      OR: [
        { status: "WAITING" },
        { decidedAt: { gte: new Date(now.getTime() - SESSION_PLAN_DECIDED_VISIBLE_MS) } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(toSessionPlanRequestView);
}
