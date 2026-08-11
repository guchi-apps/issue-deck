import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { syncRepositoryIssues } from "@/lib/github/sync-issues";
import {
  addMissingProjectItems,
  reconcileProjectStatusesFromLabels,
  syncProjectStatuses,
} from "@/lib/github/sync-project-status";

export function POST() {
  return withGithubApiFeature("sync", () => handlePOST());
}

async function handlePOST() {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const repositories = await db.repository.findMany({
    where: { installation: { userInstallations: { some: { userId } } } },
    include: { installation: true },
  });

  // 全リポジトリを並列実行するとMariaDBへの書き込みが競合しデッドロックするため、1件ずつ順番に処理する。
  const errors: { repo: string; message: string }[] = [];
  for (const repo of repositories) {
    try {
      await syncRepositoryIssues(repo);
    } catch (error) {
      errors.push({
        repo: repo.fullName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Issueを取り込んだあとにProject Statusを重ねる（#991）。Webhookの取りこぼしや
  // 初回導入時のバックフィルを、明示的な再同期でも回収できるようにするため。
  // Projectを使わない設定（環境変数未設定）なら何もせず返る。
  //
  // そのうえで、進捗ラベルとStatusのズレをラベル基準で是正する（Phase 2）。報告API
  // （POST /api/progress）がissue-deckの停止中・疎通失敗で取りこぼした変化を、
  // 再同期ボタンで回収できるようにする経路。順序が逆だとProject→DBの取り込みが
  // 是正結果を上書きしてしまうため、必ずsyncProjectStatusesの後に行う。
  const installationIds = [...new Set(repositories.map((repo) => repo.installation.installationId))];
  for (const installationId of installationIds) {
    try {
      // 盤面に載っていないIssueを先に載せる（#1036）。Project WorkflowsのAuto-addは
      // プランごとに設定できるリポジトリ数の上限があり、対象リポジトリ全体には届かない。
      // 先に載せておかないと、続くsyncProjectStatusesが取りこぼす
      const backfill = await addMissingProjectItems(installationId);
      if (backfill.skipped) break;
      const result = await syncProjectStatuses(installationId);
      if (result.skipped) break;
      await reconcileProjectStatusesFromLabels(installationId);
    } catch (error) {
      // Project連携が失敗してもIssueの再同期自体は成功しているため、全体を失敗にはしない
      errors.push({
        repo: "projects-v2",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ synced: repositories.length - errors.length, errors });
}
