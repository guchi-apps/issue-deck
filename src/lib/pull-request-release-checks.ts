import { db } from "@/lib/db";
import { getReleaseVerificationConfig } from "@/lib/release-verification-config";
import {
  isReleasePullRequest,
  parseReleaseVerificationKind,
  parseReleaseVerificationState,
  viewReleaseVerifications,
  type ReleaseVerificationView,
} from "@/lib/release-merge-gate";
import type { PullRequestReleaseCheckState, PullRequestReleaseChecks } from "@/types/pull-request";

/**
 * PR一覧のリリースPRに出す、統合検証・全体レビューの状態（#4349）。
 *
 * **判定は`release-merge-gate.ts`の`viewReleaseVerifications`に委ねる**（リリース画面・マージAPIと
 * 食い違わせない）。ここは一覧向けに状態を畳み、DBを1クエリ引くだけで、GitHub APIは使わない。
 */
function toListState(view: ReleaseVerificationView): PullRequestReleaseCheckState {
  switch (view.state) {
    case "waiting":
    case "running":
      return "running";
    default:
      return view.state;
  }
}

export function summarizeReleaseChecks(
  current: { baseSha: string; headSha: string },
  records: Parameters<typeof viewReleaseVerifications>[1],
): PullRequestReleaseChecks {
  const views = viewReleaseVerifications(current, records);
  const stateOf = (kind: "integration" | "ai_review") => {
    const view = views.find((v) => v.kind === kind);
    return view ? toListState(view) : "not_run";
  };
  return { aiReview: stateOf("ai_review"), integration: stateOf("integration") };
}

type Target = {
  repositoryFullName: string;
  number: number;
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha: string | null;
};

/** リリースPRのキー。`<repo>#<number>` */
export function releaseChecksKey(repositoryFullName: string, number: number): string {
  return `${repositoryFullName}#${number}`;
}

/**
 * リリースPR（base=main・head=`release-main/v*`）の検証状態を、全リポジトリぶんまとめて1クエリで引く。
 * 基準SHAが取れない・DBを読めないときは何も返さず、一覧は枠を出さない（成功と推測しない）。
 */
export async function fetchReleaseChecks(
  targets: Target[],
): Promise<Map<string, PullRequestReleaseChecks>> {
  const result = new Map<string, PullRequestReleaseChecks>();
  const releases = targets.filter(
    // 検証を強制していないリポジトリはマージゲートも判定しないので、一覧にも出さない
    (target) =>
      isReleasePullRequest(target) &&
      target.baseSha !== null &&
      getReleaseVerificationConfig(target.repositoryFullName).enforced,
  );
  if (releases.length === 0) return result;
  try {
    const rows = await db.releaseVerification.findMany({
      where: { OR: releases.map((t) => ({ repoFullName: t.repositoryFullName, prNumber: t.number })) },
      orderBy: { updatedAt: "desc" },
    });
    for (const target of releases) {
      const records = rows
        .filter((row) => row.repoFullName === target.repositoryFullName && row.prNumber === target.number)
        .flatMap((row) => {
          const kind = parseReleaseVerificationKind(row.kind);
          const state = parseReleaseVerificationState(row.state);
          if (!kind || !state) return [];
          return [{ kind, state, baseSha: row.baseSha, headSha: row.headSha, unverifiedScope: row.unverifiedScope }];
        });
      result.set(
        releaseChecksKey(target.repositoryFullName, target.number),
        summarizeReleaseChecks({ baseSha: target.baseSha as string, headSha: target.headSha }, records),
      );
    }
  } catch (error) {
    console.error("[GET /api/pull-requests] 検証記録を読めませんでした:", error);
  }
  return result;
}
