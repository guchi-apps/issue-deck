import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { releaseDecisionScopeKey, resolveReleaseDecisionChain } from "@/lib/release-review-decision-store";
import type { ReleaseReviewNoteRecord, ReleaseReviewNotes, ReviewNoteTarget } from "@/lib/release-review-note";

/**
 * 判断メモ（#5252）の読み書き。**判断メモは追記専用で、AIの判定・ゲート・公開承認から読まれない。**
 * 範囲（`scopeKey`）は指摘ごとの判断（`ReleaseReviewDecision`）と同じ候補系列。
 */

type NoteRow = Prisma.ReleaseReviewNoteGetPayload<object>;

async function toRecords(rows: readonly NoteRow[]): Promise<ReleaseReviewNoteRecord[]> {
  const userIds = [...new Set(rows.map((r) => r.authorUserId))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, githubLogin: true, name: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name ?? u.githubLogin]));
  return rows.map((r) => ({
    id: r.id,
    target: r.targetKind === "check" && r.checkId ? { kind: "check", checkId: r.checkId } : { kind: "overall" },
    body: r.body,
    followUp: r.followUp,
    prNumber: r.prNumber,
    baseSha: r.baseSha,
    headSha: r.headSha,
    author: names.get(r.authorUserId) ?? "不明なユーザー",
    createdAt: r.createdAt.toISOString(),
  }));
}

/** リリースPRの候補系列の判断メモ。表が無い・読めないときはnull（メモなしと同じ扱い。画面は開ける） */
export async function loadReleaseReviewNotes(repoFullName: string, prNumber: number): Promise<ReleaseReviewNotes | null> {
  try {
    const chain = await resolveReleaseDecisionChain(repoFullName, prNumber);
    const rows = await db.releaseReviewNote.findMany({
      where: { scopeKey: releaseDecisionScopeKey(repoFullName, chain) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
    });
    return { records: await toRecords(rows) };
  } catch (error) {
    console.error("[release-review-note] load failed", repoFullName, prNumber, error);
    return null;
  }
}

export async function saveReleaseReviewNote(input: {
  scopeKey: string;
  repoFullName: string;
  target: ReviewNoteTarget;
  body: string;
  followUp: string | null;
  prNumber: number;
  baseSha: string;
  headSha: string;
  userId: string;
}): Promise<ReleaseReviewNoteRecord> {
  const row = await db.releaseReviewNote.create({
    data: {
      scopeKey: input.scopeKey,
      repoFullName: input.repoFullName,
      targetKind: input.target.kind,
      checkId: input.target.kind === "check" ? input.target.checkId : null,
      body: input.body.slice(0, 2000),
      followUp: input.followUp?.slice(0, 300) ?? null,
      prNumber: input.prNumber,
      baseSha: input.baseSha,
      headSha: input.headSha,
      authorUserId: input.userId,
    },
  });
  return (await toRecords([row]))[0];
}
