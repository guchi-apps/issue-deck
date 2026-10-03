/**
 * ホストが検出した、現在稼働中の計画レビュー（G1）セッション。
 *
 * 実装セッションとは tmux 名の規約も寿命も異なるため、`DispatchSession` には混ぜない。
 * ここはホストの申告の一部として毎巡置き換える、画面表示専用の写しである。
 */
export type DispatchPlanReviewSession = {
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string | null;
  issueId: string | null;
};

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PLAN_REVIEW_SESSIONS = 20;

/** poller から来た一覧を、画面へ保存してよい最小の形に絞る。 */
export function parseDispatchPlanReviewSessions(
  value: unknown,
): DispatchPlanReviewSession[] | null {
  if (!Array.isArray(value)) return null;

  const seen = new Set<string>();
  const sessions: DispatchPlanReviewSession[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { repositoryFullName, issueNumber } = item as Record<string, unknown>;
    if (
      typeof repositoryFullName !== "string" ||
      !REPOSITORY_PATTERN.test(repositoryFullName) ||
      typeof issueNumber !== "number" ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber < 1
    ) {
      continue;
    }
    const key = `${repositoryFullName}#${issueNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({ repositoryFullName, issueNumber, issueTitle: null, issueId: null });
    if (sessions.length === MAX_PLAN_REVIEW_SESSIONS) break;
  }
  return sessions;
}
