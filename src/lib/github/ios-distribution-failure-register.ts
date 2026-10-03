import { db } from "@/lib/db";

/**
 * 画面から手動で起票した修正Issueを、iOS配布失敗の追跡Issueとして登録する（#3784）。
 *
 * 登録すると、巡回（`ios-distribution-failure-sweep-run.ts`）は自動起票のIssueと同じ扱いにする
 * （同じ失敗なら見送り・別の実行が落ちたら書き足し・成功したら自動クローズ）。
 *
 * **リポジトリごとに`open`の行は1件に保つ。** 2件になると巡回の`updateMany`が
 * `(repositoryFullName, runId)`の一意制約に当たり、そのリポジトリの巡回が止まる。
 * 既にあれば登録せず、その番号を返す（画面は「起票済み」の表示へ切り替える）。
 */
export type RegisterTrackedIssueResult =
  | { kind: "registered"; issueNumber: number }
  | { kind: "already_tracked"; issueNumber: number };

export async function registerManualIosFailureIssue(input: {
  repositoryFullName: string;
  runId: number;
  runUrl: string;
  failedStage: string | null;
  issueNumber: number;
  now?: Date;
}): Promise<RegisterTrackedIssueResult> {
  const { repositoryFullName, runId, runUrl, failedStage, issueNumber } = input;
  const open = await db.iosDistributionFailureIssue.findFirst({
    where: { repositoryFullName, state: "open" },
    orderBy: { detectedAt: "desc" },
  });
  if (open) return { kind: "already_tracked", issueNumber: open.issueNumber };

  const data = { issueNumber, state: "open", failedStage, runUrl, detectedAt: input.now ?? new Date(), resolvedAt: null };
  // 同じrunの`closed`行（人が自動起票Issueを先に閉じた場合）は、番号を差し替えて開き直す
  await db.iosDistributionFailureIssue.upsert({
    where: { repositoryFullName_runId: { repositoryFullName, runId: BigInt(runId) } },
    create: { repositoryFullName, runId: BigInt(runId), ...data },
    update: data,
  });
  return { kind: "registered", issueNumber };
}
