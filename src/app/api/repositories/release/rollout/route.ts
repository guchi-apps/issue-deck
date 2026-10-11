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

/**
 * リリース検証（統合検証・全体レビュー）の導入状況の一覧（#4365）。読み取り専用で、検証は起動しない。
 *
 * 対象はユーザーが接続済み（アクセスできる）リポジトリだけ（#4395）。台帳に載っていない
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
  // 応答対象はユーザーが接続済みのリポジトリに限る。設定ファイル上の他の管理対象を加えると、
  // アクセスできないリポジトリ名・検証状況・ホスト名まで見えてしまう（#4395）
  const names = new Set(managed.map((repo) => repo.fullName));

  const now = new Date();
  const hostRows = await db.dispatchHost.findMany();
  // ホストも同じ可視範囲に絞る。担当リポジトリを見える範囲へ限り、見えるリポジトリを担当しないホストは返さない
  const hosts = hostRows
    .map((host) => ({
      name: host.name,
      online: isDispatchHostOnline(host.lastSeenAt, now),
      repositories: parseDispatchHostRepositories(host.repositories).filter((name) => names.has(name)),
      releaseVerifyCapable: host.releaseVerifyCapable === true,
      releaseReviewCapable: host.releaseReviewCapable === true,
    }))
    .filter((host) => host.repositories.length > 0);

  const records = await db.releaseVerification.findMany({
    where: { repoFullName: { in: [...names] }, kind: { in: ["integration", "ai_review"] } },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    select: { repoFullName: true, kind: true, state: true, prNumber: true, baseSha: true, headSha: true },
  });
  // 候補（PR・base・head）ごとに2種類をまとめる。**両方が同じ候補で合格した組**があればそれを採り、
  // 無ければ種別ごとの最新を表示用に使う（evaluateRolloutは別候補の組を検証済みにしない）
  const byCandidate = new Map<string, Map<string, RolloutLatestRecords>>();
  const newestByRepo = new Map<string, RolloutLatestRecords>();
  for (const record of records) {
    const kind = record.kind as "integration" | "ai_review";
    const entry = { state: record.state, headSha: record.headSha, prNumber: record.prNumber, baseSha: record.baseSha };
    const newest = newestByRepo.get(record.repoFullName) ?? {};
    if (!newest[kind]) newest[kind] = entry;
    newestByRepo.set(record.repoFullName, newest);

    const candidates = byCandidate.get(record.repoFullName) ?? new Map<string, RolloutLatestRecords>();
    const key = `${record.prNumber}:${record.baseSha}:${record.headSha}`;
    const group = candidates.get(key) ?? {};
    if (!group[kind]) group[kind] = entry;
    candidates.set(key, group);
    byCandidate.set(record.repoFullName, candidates);
  }
  const latestByRepo = new Map<string, RolloutLatestRecords>();
  for (const name of names) {
    const pair = [...(byCandidate.get(name)?.values() ?? [])].find(
      (g) => g.integration?.state === "passed" && g.ai_review?.state === "passed",
    );
    latestByRepo.set(name, pair ?? newestByRepo.get(name) ?? {});
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
