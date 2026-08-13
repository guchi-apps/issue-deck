import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { syncRepositoryIssues } from "@/lib/github/sync-issues";
import { addMissingProjectItems, syncProjectStatuses } from "@/lib/github/sync-project-status";

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
  // Phase 2にあった「進捗ラベルを正としてStatusへ書き戻す」是正は、Phase 5（#1010）で
  // ラベルを廃止したため無くなった。**Statusが唯一の正で、写し元がもう無い。**
  // 報告API（POST /api/progress）が取りこぼした変化は、GitHub側のProjectを直接直すか、
  // 該当の遷移をもう一度起こすことでしか回収できない。
  const installationIds = [...new Set(repositories.map((repo) => repo.installation.installationId))];
  for (const installationId of installationIds) {
    try {
      // **順序が重要（#1137）。** 先にProjectの内容をDBへ取り込み、そのあとで盤面に
      // 載っていないIssueを追加する（#1036。Project WorkflowsのAuto-addはプランごとの
      // リポジトリ数上限があり、対象リポジトリ全体には届かないため、issue-deckが載せる）。
      //
      // 逆順にすると、`addMissingProjectItems`が追加直後に書いたStatusを
      // `syncProjectStatuses`が消してしまう。あちらはProjectを読み直した結果を無条件に
      // DBへ書くが、**追加直後のアイテムはProjects APIがまだ`Ready`を返さないことがあり**、
      // その`null`で上書きされる。DBが`null`のままだとカンバン起点の起動が`from`に
      // その値を使うため、載せた直後の最初のドラッグが無反応になる（#1132）。
      //
      // この順序で取りこぼしは起きない。新規追加分は`addMissingProjectItems`が
      // 自分でDBへ書くため（#1132）、`syncProjectStatuses`に拾ってもらう必要がない。
      const result = await syncProjectStatuses(installationId);
      if (result.skipped) break;
      const backfill = await addMissingProjectItems(installationId);
      if (backfill.skipped) break;
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
