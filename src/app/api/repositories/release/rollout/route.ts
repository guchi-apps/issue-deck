import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { isDispatchHostOnline, parseDispatchHostRepositories } from "@/lib/dispatch/dispatch-job";
import {
  evaluateRollout,
  isRolloutComplete,
  sortRolloutRows,
  type RolloutLatestRecords,
} from "@/lib/release-rollout";
import { RELEASE_VERIFICATION_EXCLUSIONS, RELEASE_VERIFICATION_REPOS } from "@/lib/release-verification-config";

/**
 * リリース検証（統合検証・全体レビュー）の導入状況の一覧（#4365）。読み取り専用で、検証は起動しない。
 *
 * 対象は「ユーザーが管理するリポジトリ」と「台帳に載せたリポジトリ」の和集合。台帳に載っていない
 * 管理対象は`not_registered`として出し、導入漏れを成功扱いにしない。状態は宣言（コード）と
 * `ReleaseVerification`・`DispatchHost`から導出する（`release-rollout.ts`）。
 */
export async function GET() {
  const userId = await requireUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const managed = await db.repository.findMany({
    where: { installation: { userInstallations: { some: { userId } } } },
    select: { fullName: true, archived: true },
  });
  const archived = new Map(managed.map((repo) => [repo.fullName, repo.archived]));
  const names = new Set([
    ...managed.map((repo) => repo.fullName),
    ...Object.keys(RELEASE_VERIFICATION_REPOS),
    ...Object.keys(RELEASE_VERIFICATION_EXCLUSIONS),
  ]);

  const now = new Date();
  const hostRows = await db.dispatchHost.findMany();
  const hosts = hostRows.map((host) => ({
    name: host.name,
    online: isDispatchHostOnline(host.lastSeenAt, now),
    repositories: parseDispatchHostRepositories(host.repositories),
    releaseVerifyCapable: host.releaseVerifyCapable === true,
    releaseReviewCapable: host.releaseReviewCapable === true,
  }));

  const records = await db.releaseVerification.findMany({
    where: { repoFullName: { in: [...names] }, kind: { in: ["integration", "ai_review"] } },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    select: { repoFullName: true, kind: true, state: true, headSha: true },
  });
  const latestByRepo = new Map<string, RolloutLatestRecords>();
  for (const record of records) {
    const latest = latestByRepo.get(record.repoFullName) ?? {};
    const kind = record.kind as "integration" | "ai_review";
    // 実走の記録だけを見る（依頼しただけの`waiting`・対象外は、合格の証跡にしない）
    if (!latest[kind]) latest[kind] = { state: record.state, headSha: record.headSha };
    latestByRepo.set(record.repoFullName, latest);
  }

  const rows = sortRolloutRows(
    [...names].map((fullName) =>
      evaluateRollout({
        fullName,
        archived: archived.get(fullName) ?? false,
        hosts,
        latest: latestByRepo.get(fullName) ?? {},
      }),
    ),
  );
  return NextResponse.json(
    { repositories: rows, complete: isRolloutComplete(rows) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
