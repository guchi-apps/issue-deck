import { db } from "@/lib/db";
import { getInstallationToken } from "@/lib/github/app-auth";
import { syncInstallationRepositories } from "@/lib/github/repository-sync";
import { syncRepositoryIssues } from "@/lib/github/sync-issues";

/**
 * 立ち上げで作ったリポジトリを、その場で盤面へ取り込む（#2248）。
 *
 * **設定の「リポジトリを再同期」→「Issueを再同期」と同じことを、立ち上げ自身が行う。**
 * `repository_selection=all`のインストールでは新しいリポジトリを足しても
 * `installation_repositories`のwebhookが飛ばないため、押すまでDBに現れない。押し忘れると
 * 初期化Issueが画面に出ず、実際に#2215では押されないままになっていた。
 *
 * **Issueの再同期は作ったリポジトリ1つだけに絞る。** 画面のボタンは接続中の全リポジトリを
 * 回すが、ここで欲しいのは今作ったものだけで、20以上のリポジトリを回すとGitHub APIの
 * 消費と待ち時間だけが増える。
 *
 * **Projectへの追加（`addMissingProjectItems`）は呼ばない。** 対象は
 * `claude-issue-dispatch.yml`を持つリポジトリに限られ、それを作るのが初期化Issue自身なので、
 * この時点で呼んでも何も載らない（`docs/new-app-launch.md`「新しいリポジトリのIssueは、
 * 作った直後には盤面に載らない」）。
 */

export type NewAppResyncResult =
  | { ok: true }
  | { ok: false; message: string };

export async function resyncNewRepository(
  userId: string,
  ownerLogin: string,
  repositoryName: string,
): Promise<NewAppResyncResult> {
  const fullName = `${ownerLogin}/${repositoryName}`;
  try {
    const installations = await db.githubInstallation.findMany({
      where: {
        accountLogin: ownerLogin,
        userInstallations: { some: { userId } },
      },
    });
    if (installations.length === 0) {
      return { ok: false, message: `${ownerLogin} のGitHub Appのインストールが見つかりませんでした。` };
    }

    // 1. リポジトリの再同期。**1件ずつ順番に回す**——並列にするとMariaDBへの書き込みが
    //    競合してデッドロックする（`/api/sync/repositories`と同じ理由）
    for (const installation of installations) {
      const token = await getInstallationToken(installation.installationId);
      await syncInstallationRepositories(installation, token);
    }

    // 2. 作ったリポジトリのIssueの再同期
    const repository = await db.repository.findFirst({
      where: { fullName },
      include: { installation: true },
    });
    if (!repository) {
      return {
        ok: false,
        message: `${fullName} がGitHub Appのインストール対象に見つかりませんでした。`,
      };
    }
    await syncRepositoryIssues(repository);

    return { ok: true };
  } catch (error) {
    console.error("[new-app] 作成したリポジトリの再同期に失敗しました", error);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
