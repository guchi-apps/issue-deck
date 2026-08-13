import { NextResponse } from "next/server";

import { requireUserId } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { withGithubApiFeature } from "@/lib/github/api-usage";
import { syncRepositoryIssues } from "@/lib/github/sync-issues";
import { addMissingProjectItems, syncProjectStatuses } from "@/lib/github/sync-project-status";

// 再同期の失敗。kindで由来を区別する（#1141）。
// - repository: そのリポジトリのIssue取り込みが失敗した。syncedから差し引く
// - projects-v2: インストール単位のProject連携が失敗した。リポジトリ横断のためsyncedには影響しない
type SyncError = {
  kind: "repository" | "projects-v2";
  repo: string;
  message: string;
};

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

  // **リポジトリ単位の失敗とインストール単位の失敗を分けて持つ（#1141）。**
  // 混ぜて数えると、Project連携が1件落ちただけで同期できたリポジトリ数まで減って見える
  // （リポジトリが1つの環境では 1 - 1 = 0 になり「1つも同期できなかった」と表示される）。
  const repositoryErrors: SyncError[] = [];
  const projectErrors: SyncError[] = [];

  // 全リポジトリを並列実行するとMariaDBへの書き込みが競合しデッドロックするため、1件ずつ順番に処理する。
  for (const repo of repositories) {
    try {
      await syncRepositoryIssues(repo);
    } catch (error) {
      repositoryErrors.push({
        kind: "repository",
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
      projectErrors.push({
        kind: "projects-v2",
        // リポジトリ横断の失敗のため、特定のリポジトリ名は持たない。画面側は kind を見て
        // 「Project連携」と表示する
        repo: "projects-v2",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // syncedはリポジトリ単位の失敗だけを差し引く。errorsは呼び出し側が両方を表示できるよう
  // 連結して返す（kindで区別できる）。
  return NextResponse.json({
    synced: repositories.length - repositoryErrors.length,
    errors: [...repositoryErrors, ...projectErrors],
  });
}
