import { db } from "@/lib/db";

/**
 * Issue作成の冪等キー（#3847）。連打や応答不明からの再試行で同じIssueを二重に作らない。
 *
 * **GitHubへ作成する前にキーを予約する**（作成後に記録する順序だと、作成成功→記録前に落ちた
 * ときに再送が重複を作る）。予約済みで結果が無いキーは「作成中・結果不明」として`in_progress`を
 * 返し、再作成しない。作成に確実に失敗したときだけ予約を外して再試行できるようにする。
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export function parseIdempotencyKey(value: unknown): string | null {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value) ? value : null;
}

export type ReserveResult =
  | { kind: "reserved" }
  | { kind: "done"; result: unknown }
  | { kind: "in_progress" };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export async function reserveIssueCreate(userId: string, key: string): Promise<ReserveResult> {
  // 古い記録を掃除する（失敗しても作成は止めない）
  await db.issueCreateRequest
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RETENTION_MS) } } })
    .catch(() => undefined);
  try {
    await db.issueCreateRequest.create({ data: { userId, key, status: "pending" } });
    return { kind: "reserved" };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const existing = await db.issueCreateRequest.findUnique({
    where: { userId_key: { userId, key } },
  });
  if (existing?.status === "done" && existing.resultJson) {
    try {
      return { kind: "done", result: JSON.parse(existing.resultJson) };
    } catch {
      return { kind: "in_progress" };
    }
  }
  return { kind: "in_progress" };
}

export async function completeIssueCreate(userId: string, key: string, result: unknown): Promise<void> {
  await db.issueCreateRequest.update({
    where: { userId_key: { userId, key } },
    data: { status: "done", resultJson: JSON.stringify(result) },
  });
}

/** 作成に確実に失敗したとき（GitHubへ届いていない）だけ呼ぶ。外すと同じキーで再試行できる */
export async function releaseIssueCreate(userId: string, key: string): Promise<void> {
  await db.issueCreateRequest.deleteMany({ where: { userId, key, status: "pending" } });
}
